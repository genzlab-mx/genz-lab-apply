-- =====================================================================
-- Gen Z Lab. 지원서 모집 — Supabase 스키마
-- 지원서 전용 Supabase 프로젝트에서 실행합니다. 이미 있는 다른 테이블은 건드리지 않습니다.
-- Supabase 대시보드 > SQL Editor 에 통째로 붙여 넣고 Run 하세요. 여러 번 실행해도 안전합니다.
-- =====================================================================

-- PIN을 bcrypt로 저장하기 위해 pgcrypto를 씁니다(Supabase에는 기본으로 설치되어 있습니다).
create extension if not exists pgcrypto with schema extensions;

-- 1) 테이블 -------------------------------------------------------------

-- 지원서(모집) 하나. 주소의 ?f=코드 로 고릅니다. 기본 코드는 'apply'.
create table if not exists public.apply_forms (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  title      text not null default '지원서' check (char_length(btrim(title)) between 1 and 60),
  intro      text not null default '' check (char_length(intro) <= 1000),
  is_open    boolean not null default true,              -- 모집 중 / 마감
  created_at timestamptz not null default now()
);

-- 질문. 관리 화면에서 추가·수정·삭제·순서 변경을 합니다.
--   short: 단답형 / long: 장문형 / single: 객관식(하나) / multi: 객관식(여러 개)
create table if not exists public.apply_questions (
  id          uuid primary key default gen_random_uuid(),
  form_id     uuid not null references public.apply_forms (id) on delete cascade,
  position    integer not null default 0,
  type        text not null check (type in ('short', 'long', 'single', 'multi')),
  title       text not null check (char_length(btrim(title)) between 1 and 200),
  description text not null default '' check (char_length(description) <= 500),
  options     jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  required    boolean not null default true,
  max_length  integer check (max_length is null or max_length between 1 and 5000), -- 비우면 단답 200자, 장문 3000자
  created_at  timestamptz not null default now()
);
create index if not exists apply_questions_form_idx on public.apply_questions (form_id, position);

-- 지원자 한 명의 지원서. Knox ID 하나에 한 장. 답변은 {질문id: 값} 모양의 JSON으로 둡니다.
create table if not exists public.apply_applicants (
  form_id      uuid not null references public.apply_forms (id) on delete cascade,
  knox_id      text not null check (knox_id = lower(btrim(knox_id)) and char_length(knox_id) between 1 and 40),
  name         text not null check (char_length(btrim(name)) between 1 and 30),
  pin_hash     text,                                   -- null 이면 관리자가 PIN을 초기화한 상태
  answers      jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  status       text not null default 'draft' check (status in ('draft', 'submitted')),
  failed_pins  integer not null default 0,             -- PIN을 연속으로 틀린 횟수
  locked_until timestamptz,                            -- 5번 틀리면 10분 잠금
  created_at   timestamptz not null default now(),
  saved_at     timestamptz,                            -- 마지막 임시 저장
  submitted_at timestamptz,
  primary key (form_id, knox_id)
);

-- 2) 권한 ---------------------------------------------------------------
--    세 테이블 모두 공개 키로는 직접 읽고 쓸 수 없습니다(RLS 켜고 정책 없음).
--    지원자는 아래 ap_* 함수로 "자기 것"만, 관리자는 Edge Function(apply-admin)으로만 봅니다.

alter table public.apply_forms      enable row level security;
alter table public.apply_questions  enable row level security;
alter table public.apply_applicants enable row level security;

revoke all on public.apply_forms, public.apply_questions, public.apply_applicants from anon, authenticated;
grant  all on public.apply_forms, public.apply_questions, public.apply_applicants to service_role;

-- 3) 내부 도우미 (공개 키로는 부를 수 없음) --------------------------------

create or replace function public.ap_fail(p_code text, p_message text)
returns jsonb
language sql
immutable
set search_path = ''
as $$ select jsonb_build_object('ok', false, 'error', p_code, 'message', p_message) $$;

-- Knox ID 정리: 앞뒤 공백 제거, 소문자, '@' 뒤(메일 주소)는 버림
create or replace function public.ap_knox(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select split_part(lower(btrim(coalesce(p, ''))), '@', 1) $$;

create or replace function public.ap_questions_json(p_form uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', q.id, 'type', q.type, 'title', q.title, 'description', q.description,
           'options', q.options, 'required', q.required, 'max_length', q.max_length)
         order by q.position, q.created_at), '[]'::jsonb)
    from public.apply_questions q
   where q.form_id = p_form
$$;

-- PIN 확인. 예외를 던지지 않고 결과를 글자로 돌려줍니다(틀린 횟수가 저장되도록).
--   'ok' | 'not_found' | 'no_pin' | 'locked' | 'wrong:<남은 횟수>'
create or replace function public.ap_verify_pin(p_form uuid, p_knox text, p_pin text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.apply_applicants%rowtype;
  n integer;
begin
  select * into a from public.apply_applicants
   where form_id = p_form and knox_id = p_knox
   for update;
  if not found then return 'not_found'; end if;
  if a.pin_hash is null then return 'no_pin'; end if;
  if a.locked_until is not null and a.locked_until > now() then return 'locked'; end if;

  if coalesce(p_pin, '') ~ '^[0-9]{4}$' and extensions.crypt(p_pin, a.pin_hash) = a.pin_hash then
    if a.failed_pins <> 0 or a.locked_until is not null then
      update public.apply_applicants set failed_pins = 0, locked_until = null
       where form_id = p_form and knox_id = p_knox;
    end if;
    return 'ok';
  end if;

  n := a.failed_pins + 1;
  if n >= 5 then
    update public.apply_applicants set failed_pins = 0, locked_until = now() + interval '10 minutes'
     where form_id = p_form and knox_id = p_knox;
    return 'locked';
  end if;
  update public.apply_applicants set failed_pins = n, locked_until = null
   where form_id = p_form and knox_id = p_knox;
  return 'wrong:' || (5 - n);
end;
$$;

create or replace function public.ap_pin_fail(p_result text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_result = 'not_found' then public.ap_fail('not_found', '작성 중인 지원서를 찾지 못했어요. 처음부터 다시 시도해 주세요.')
    when p_result = 'no_pin'    then public.ap_fail('no_pin', 'PIN이 초기화됐어요. 새 PIN을 정해 주세요.')
    when p_result = 'locked'    then public.ap_fail('locked', 'PIN을 5번 틀려서 10분 동안 잠겼어요. 잠시 뒤 다시 시도해 주세요.')
    else public.ap_fail('wrong_pin', 'PIN이 맞지 않아요. ' || split_part(p_result, ':', 2) || '번 더 틀리면 10분 동안 잠겨요.')
  end
$$;

create or replace function public.ap_state(p_form uuid, p_knox text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'ok', true, 'knox_id', a.knox_id, 'name', a.name, 'status', a.status, 'answers', a.answers,
           'saved_at', a.saved_at, 'submitted_at', a.submitted_at, 'is_open', f.is_open)
    from public.apply_applicants a
    join public.apply_forms f on f.id = a.form_id
   where a.form_id = p_form and a.knox_id = p_knox
$$;

revoke all on function public.ap_fail(text, text), public.ap_knox(text), public.ap_questions_json(uuid),
  public.ap_verify_pin(uuid, text, text), public.ap_pin_fail(text), public.ap_state(uuid, text)
  from public, anon, authenticated;

-- 4) 지원자용 함수 -------------------------------------------------------
--    모두 jsonb를 돌려줍니다. 실패하면 {ok:false, error, message}.

-- 지원서 제목·안내·질문 (로그인 전에도 보임)
create or replace function public.ap_form(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  f public.apply_forms%rowtype;
begin
  select * into f from public.apply_forms where code = p_code;
  if not found then return public.ap_fail('no_form', '지원서를 찾지 못했어요. 주소를 확인해 주세요.'); end if;
  return jsonb_build_object('ok', true, 'title', f.title, 'intro', f.intro, 'is_open', f.is_open,
                            'questions', public.ap_questions_json(f.id));
end;
$$;

-- Knox ID의 상태: new(처음) | draft(작성 중) | reset(PIN 초기화됨) | submitted(제출 완료)
create or replace function public.ap_check(p_code text, p_knox_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  f public.apply_forms%rowtype;
  a public.apply_applicants%rowtype;
  v text := public.ap_knox(p_knox_id);
begin
  select * into f from public.apply_forms where code = p_code;
  if not found then return public.ap_fail('no_form', '지원서를 찾지 못했어요.'); end if;
  if char_length(v) < 1 or char_length(v) > 40 then return public.ap_fail('bad_knox', 'Knox ID를 확인해 주세요.'); end if;

  select * into a from public.apply_applicants where form_id = f.id and knox_id = v;
  return jsonb_build_object(
    'ok', true, 'knox_id', v, 'is_open', f.is_open,
    'state', case when not found then 'new'
                  when a.status = 'submitted' then 'submitted'
                  when a.pin_hash is null then 'reset'
                  else 'draft' end);
end;
$$;

-- 처음 시작(또는 PIN 초기화 뒤 새 PIN 정하기)
create or replace function public.ap_start(p_code text, p_knox_id text, p_name text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.apply_forms%rowtype;
  a public.apply_applicants%rowtype;
  v text := public.ap_knox(p_knox_id);
  n text := btrim(coalesce(p_name, ''));
begin
  select * into f from public.apply_forms where code = p_code;
  if not found then return public.ap_fail('no_form', '지원서를 찾지 못했어요.'); end if;
  if char_length(v) < 1 or char_length(v) > 40 then return public.ap_fail('bad_knox', 'Knox ID를 확인해 주세요.'); end if;
  if char_length(n) < 1 or char_length(n) > 30 then return public.ap_fail('bad_name', '이름을 1~30자로 적어 주세요.'); end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return public.ap_fail('bad_pin', 'PIN은 숫자 4자리로 정해 주세요.'); end if;

  select * into a from public.apply_applicants where form_id = f.id and knox_id = v for update;
  if not found then
    if not f.is_open then return public.ap_fail('closed', '모집이 마감되었어요.'); end if;
    insert into public.apply_applicants (form_id, knox_id, name, pin_hash)
    values (f.id, v, n, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
    on conflict (form_id, knox_id) do nothing;
    if not found then return public.ap_fail('exists', '이미 작성 중인 지원서가 있어요. PIN으로 불러와 주세요.'); end if;
  elsif a.status = 'submitted' then
    return public.ap_fail('submitted', '이미 응답하셨습니다.');
  elsif a.pin_hash is null then
    update public.apply_applicants
       set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 8)), name = n,
           failed_pins = 0, locked_until = null
     where form_id = f.id and knox_id = v;
  else
    return public.ap_fail('exists', '이미 작성 중인 지원서가 있어요. PIN으로 불러와 주세요.');
  end if;

  return public.ap_state(f.id, v);
end;
$$;

-- 임시 저장한 내용 불러오기
create or replace function public.ap_load(p_code text, p_knox_id text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.apply_forms%rowtype;
  v text := public.ap_knox(p_knox_id);
  r text;
begin
  select * into f from public.apply_forms where code = p_code;
  if not found then return public.ap_fail('no_form', '지원서를 찾지 못했어요.'); end if;
  r := public.ap_verify_pin(f.id, v, p_pin);
  if r <> 'ok' then return public.ap_pin_fail(r); end if;
  return public.ap_state(f.id, v);
end;
$$;

-- 임시 저장 (버튼 또는 1분마다 자동)
create or replace function public.ap_save(p_code text, p_knox_id text, p_pin text, p_name text, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.apply_forms%rowtype;
  a public.apply_applicants%rowtype;
  v text := public.ap_knox(p_knox_id);
  n text := btrim(coalesce(p_name, ''));
  r text;
begin
  select * into f from public.apply_forms where code = p_code;
  if not found then return public.ap_fail('no_form', '지원서를 찾지 못했어요.'); end if;
  r := public.ap_verify_pin(f.id, v, p_pin);
  if r <> 'ok' then return public.ap_pin_fail(r); end if;

  select * into a from public.apply_applicants where form_id = f.id and knox_id = v;
  if a.status = 'submitted' then return public.ap_fail('submitted', '이미 응답하셨습니다.'); end if;
  if not f.is_open then return public.ap_fail('closed', '모집이 마감되어 저장할 수 없어요.'); end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then return public.ap_fail('bad_answers', '답변 형식이 올바르지 않아요.'); end if;
  if octet_length(p_answers::text) > 200000 then return public.ap_fail('too_long', '답변이 너무 길어요.'); end if;

  update public.apply_applicants
     set answers = p_answers, saved_at = now(),
         name = case when char_length(n) between 1 and 30 then n else name end
   where form_id = f.id and knox_id = v;

  return public.ap_state(f.id, v);
end;
$$;

-- 최종 제출. 필수 질문과 글자 수를 서버에서도 확인합니다. 제출 뒤에는 고칠 수 없습니다.
create or replace function public.ap_submit(p_code text, p_knox_id text, p_pin text, p_name text, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.apply_forms%rowtype;
  a public.apply_applicants%rowtype;
  q public.apply_questions%rowtype;
  v text := public.ap_knox(p_knox_id);
  n text := btrim(coalesce(p_name, ''));
  r text;
  ans jsonb;
  t text;
  lim integer;
begin
  select * into f from public.apply_forms where code = p_code;
  if not found then return public.ap_fail('no_form', '지원서를 찾지 못했어요.'); end if;
  r := public.ap_verify_pin(f.id, v, p_pin);
  if r <> 'ok' then return public.ap_pin_fail(r); end if;

  select * into a from public.apply_applicants where form_id = f.id and knox_id = v for update;
  if a.status = 'submitted' then return public.ap_fail('submitted', '이미 응답하셨습니다.'); end if;
  if not f.is_open then return public.ap_fail('closed', '모집이 마감되어 제출할 수 없어요.'); end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then return public.ap_fail('bad_answers', '답변 형식이 올바르지 않아요.'); end if;
  if octet_length(p_answers::text) > 200000 then return public.ap_fail('too_long', '답변이 너무 길어요.'); end if;

  for q in select * from public.apply_questions where form_id = f.id order by position, created_at loop
    ans := p_answers -> (q.id::text);
    if q.type in ('short', 'long', 'single') then
      t := btrim(coalesce(case when jsonb_typeof(ans) = 'string' then ans #>> '{}' end, ''));
      if q.required and t = '' then
        return public.ap_fail('required', '"' || q.title || '" 질문에 답해 주세요.') || jsonb_build_object('question', q.id);
      end if;
      if q.type <> 'single' then
        lim := coalesce(q.max_length, case when q.type = 'short' then 200 else 3000 end);
        if char_length(t) > lim then
          return public.ap_fail('too_long', '"' || q.title || '" 답변은 ' || lim || '자까지 쓸 수 있어요.') || jsonb_build_object('question', q.id);
        end if;
      end if;
    elsif q.required and (case when jsonb_typeof(ans) = 'array' then jsonb_array_length(ans) else 0 end) = 0 then
      return public.ap_fail('required', '"' || q.title || '" 질문에서 하나 이상 골라 주세요.') || jsonb_build_object('question', q.id);
    end if;
  end loop;

  update public.apply_applicants
     set answers = p_answers, status = 'submitted', saved_at = now(), submitted_at = now(),
         name = case when char_length(n) between 1 and 30 then n else name end
   where form_id = f.id and knox_id = v;

  return public.ap_state(f.id, v);
end;
$$;

revoke all on function public.ap_form(text), public.ap_check(text, text), public.ap_start(text, text, text, text),
  public.ap_load(text, text, text), public.ap_save(text, text, text, text, jsonb), public.ap_submit(text, text, text, text, jsonb)
  from public;
grant execute on function public.ap_form(text), public.ap_check(text, text), public.ap_start(text, text, text, text),
  public.ap_load(text, text, text), public.ap_save(text, text, text, text, jsonb), public.ap_submit(text, text, text, text, jsonb)
  to anon, authenticated, service_role;

-- 5) 첫 지원서와 예시 질문 -------------------------------------------------
--    코드는 'apply'. 질문은 관리 화면에서 마음대로 고치거나 지우면 됩니다.

do $$
declare
  fid uuid;
begin
  insert into public.apply_forms (code, title, intro)
  values ('apply', 'Gen Z Lab. 지원서', '아래 질문에 답해 주세요. 작성 중에는 1분마다 자동으로 임시 저장되고, 제출한 뒤에는 고칠 수 없어요.')
  on conflict (code) do nothing
  returning id into fid;

  if fid is not null then
    insert into public.apply_questions (form_id, position, type, title, description, options, required, max_length) values
      (fid, 1, 'short',  '소속 부서', '', '[]', true, 50),
      (fid, 2, 'long',   '지원 동기', 'Gen Z Lab.에 지원하는 이유를 자유롭게 적어 주세요.', '[]', true, 1000),
      (fid, 3, 'single', '가장 관심 있는 활동', '', '["프로그램 기획", "콘텐츠 제작", "운영·진행", "디자인"]', true, null),
      (fid, 4, 'multi',  '참여 가능한 요일', '해당하는 요일을 모두 골라 주세요.', '["월", "화", "수", "목", "금"]', true, null),
      (fid, 5, 'long',   '하고 싶은 말', '', '[]', false, 500);
  end if;
end;
$$;
