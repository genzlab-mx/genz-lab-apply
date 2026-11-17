// Gen Z Lab. 지원서 모집 — 관리자 Edge Function (이름: apply-admin)
//
// 관리 화면의 모든 동작(지원서 정보·질문 편집, 응답 조회, PIN 초기화 등)을 이 함수 하나로 처리합니다.
// 필요한 secret (대시보드 > Edge Functions > Secrets):
//   APPLY_ADMIN_PASSWORD   지원서 관리자 비밀번호 (필수, 워드클라우드의 ADMIN_PASSWORD 와 따로 둡니다)
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 는 Supabase가 자동으로 넣어 줍니다.

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function sha256(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// 비밀번호 비교: 길이·내용에 따라 걸리는 시간이 달라지지 않게 해시끼리 비교합니다.
async function passwordOk(given: unknown) {
  const expected = Deno.env.get("APPLY_ADMIN_PASSWORD") ?? "";
  if (!expected || typeof given !== "string") return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const TYPES = ["short", "long", "single", "multi"];
const QUESTION_FIELDS = "id, position, type, title, description, options, required, max_length";
const APPLICANT_FIELDS = "knox_id, name, status, answers, created_at, saved_at, submitted_at, locked_until, pin_hash";

// 관리 화면에서 받은 질문을 검사하고 저장할 모양으로 바꿉니다.
function cleanQuestion(q: Record<string, unknown>) {
  const type = String(q?.type ?? "");
  if (!TYPES.includes(type)) throw new Error("질문 유형이 올바르지 않습니다");
  const title = String(q?.title ?? "").trim();
  if (title.length < 1 || title.length > 200) throw new Error("질문은 1~200자로 적어 주세요");
  const description = String(q?.description ?? "").trim().slice(0, 500);
  let options: string[] = [];
  if (type === "single" || type === "multi") {
    const raw = Array.isArray(q?.options) ? q.options : [];
    options = [...new Set(raw.map((o) => String(o ?? "").trim().slice(0, 100)).filter(Boolean))];
    if (options.length < 2) throw new Error("보기를 2개 이상 적어 주세요");
    if (options.length > 30) throw new Error("보기는 30개까지 넣을 수 있습니다");
  }
  let max_length: number | null = null;
  if ((type === "short" || type === "long") && q?.max_length != null && q.max_length !== "") {
    const n = Number.parseInt(String(q.max_length), 10);
    if (!(n >= 1 && n <= 5000)) throw new Error("글자 수 제한은 1~5000 사이로 적어 주세요");
    max_length = n;
  }
  return { type, title, description, options, required: q?.required !== false, max_length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST만 지원합니다" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "요청 형식이 올바르지 않습니다" }, 400);
  }

  if (!(await passwordOk(body.password))) {
    await new Promise((r) => setTimeout(r, 1000)); // 무작위 대입을 느리게
    return json({ error: "비밀번호가 올바르지 않습니다" }, 401);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const code = typeof body.code === "string" ? body.code : "";
  const { data: form, error: fErr } = await db.from("apply_forms").select("*").eq("code", code).maybeSingle();
  if (fErr) return json({ error: fErr.message }, 500);
  if (!form) return json({ error: "지원서를 찾을 수 없습니다. supabase/apply.sql 을 실행했는지 확인해 주세요" }, 404);

  const loadQuestions = async () => {
    const { data, error } = await db.from("apply_questions").select(QUESTION_FIELDS)
      .eq("form_id", form.id).order("position").order("created_at");
    if (error) throw new Error(error.message);
    return data ?? [];
  };

  // 한 번에 1000줄까지만 내려오므로 끝까지 나눠 읽습니다. PIN 해시는 내보내지 않습니다.
  const loadApplicants = async () => {
    const rows: Record<string, unknown>[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("apply_applicants").select(APPLICANT_FIELDS)
        .eq("form_id", form.id).order("created_at").order("knox_id").range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const { pin_hash, ...rest } of data ?? []) rows.push({ ...rest, has_pin: pin_hash != null });
      if (!data || data.length < 1000) break;
    }
    return rows;
  };

  const knoxOf = () => String(body.knox_id ?? "").trim().toLowerCase();

  try {
    switch (body.action) {
      // 비밀번호 확인 + 지원서 정보·질문
      case "verify":
      case "form":
        return json({ ok: true, form, questions: await loadQuestions() });

      // 제목·안내 문구·모집 중 여부
      case "form_update": {
        const patch: Record<string, unknown> = {};
        if (typeof body.title === "string") {
          const title = body.title.trim();
          if (title.length < 1 || title.length > 60) return json({ error: "제목은 1~60자로 적어 주세요" }, 400);
          patch.title = title;
        }
        if (typeof body.intro === "string") patch.intro = body.intro.trim().slice(0, 1000);
        if (typeof body.is_open === "boolean") patch.is_open = body.is_open;
        if (!Object.keys(patch).length) return json({ error: "바꿀 내용이 없습니다" }, 400);
        const { data, error } = await db.from("apply_forms").update(patch).eq("id", form.id).select().single();
        if (error) throw new Error(error.message);
        return json({ ok: true, form: data, questions: await loadQuestions() });
      }

      // 질문 추가(id 없음) 또는 수정(id 있음)
      case "question_save": {
        const input = (body.question ?? {}) as Record<string, unknown>;
        const q = cleanQuestion(input);
        if (input.id) {
          const { error } = await db.from("apply_questions").update(q).eq("id", String(input.id)).eq("form_id", form.id);
          if (error) throw new Error(error.message);
        } else {
          const { data: last } = await db.from("apply_questions").select("position")
            .eq("form_id", form.id).order("position", { ascending: false }).limit(1).maybeSingle();
          const { error } = await db.from("apply_questions").insert({ ...q, form_id: form.id, position: (last?.position ?? 0) + 1 });
          if (error) throw new Error(error.message);
        }
        return json({ ok: true, form, questions: await loadQuestions() });
      }

      case "question_delete": {
        const { error } = await db.from("apply_questions").delete().eq("id", String(body.id ?? "")).eq("form_id", form.id);
        if (error) throw new Error(error.message);
        return json({ ok: true, form, questions: await loadQuestions() });
      }

      // 순서 바꾸기: ids = 새 순서대로 나열한 질문 id
      case "question_move": {
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const results = await Promise.all(ids.map((id, i) =>
          db.from("apply_questions").update({ position: i + 1 }).eq("id", id).eq("form_id", form.id)));
        const failed = results.find((r) => r.error);
        if (failed?.error) throw new Error(failed.error.message);
        return json({ ok: true, form, questions: await loadQuestions() });
      }

      // 응답 목록 (작성 중 + 제출 완료)
      case "responses":
        return json({ ok: true, form, questions: await loadQuestions(), applicants: await loadApplicants() });

      // PIN을 잊은 지원자: PIN을 지우면 다음에 들어올 때 새 PIN을 정합니다(작성 내용은 그대로).
      case "applicant_reset_pin": {
        const { error } = await db.from("apply_applicants")
          .update({ pin_hash: null, failed_pins: 0, locked_until: null })
          .eq("form_id", form.id).eq("knox_id", knoxOf());
        if (error) throw new Error(error.message);
        return json({ ok: true, applicants: await loadApplicants() });
      }

      // 제출 취소: 제출한 지원서를 다시 '작성 중'으로 돌려 지원자가 고칠 수 있게 합니다.
      case "applicant_reopen": {
        const { error } = await db.from("apply_applicants")
          .update({ status: "draft", submitted_at: null })
          .eq("form_id", form.id).eq("knox_id", knoxOf());
        if (error) throw new Error(error.message);
        return json({ ok: true, applicants: await loadApplicants() });
      }

      case "applicant_delete": {
        const { error } = await db.from("apply_applicants").delete().eq("form_id", form.id).eq("knox_id", knoxOf());
        if (error) throw new Error(error.message);
        return json({ ok: true, applicants: await loadApplicants() });
      }

      default:
        return json({ error: "알 수 없는 동작입니다" }, 400);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
