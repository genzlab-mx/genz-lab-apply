# Gen Z Lab. 지원서 모집

Knox ID와 이름으로 들어와 지원서를 쓰는 웹 페이지입니다. 스마트폰과 노트북 모두에서 쓸 수 있습니다.
워드클라우드 사이트(genz-lab-Word-Cloud)와 같은 방식(GitHub Pages + Supabase)으로 동작하지만, Supabase 프로젝트는 지원서 전용으로 따로 씁니다.

| 화면 | 누가 | 파일 |
|---|---|---|
| 지원서 | 지원자 · 스마트폰/노트북 | `index.html` + `js/apply.js` |
| 관리 | 담당자 · 노트북 | `admin.html` + `js/admin.js` |

## 지원자 흐름

1. Knox ID와 이름을 적습니다. (`gildong.hong@samsung.com`처럼 적어도 `@` 뒤는 떼고 소문자로 맞춥니다)
2. Knox ID 상태에 따라 다음 화면이 달라집니다.
   - **처음** → PIN 4자리를 정하고 지원서를 씁니다.
   - **임시 저장한 적 있음** → PIN을 입력하면 저장한 내용을 불러옵니다.
   - **이미 제출함** → "이미 응답하셨습니다" 화면이 나옵니다.
   - **모집 마감 + 처음** → "모집이 마감되었어요" 화면이 나옵니다.
3. 작성 중에는 아래 **임시 저장** 버튼으로 저장할 수 있고, **바뀐 내용이 있으면 1분마다 자동으로 저장**합니다. 다른 앱으로 넘어가거나 탭을 숨길 때도 저장합니다.
4. **제출하기**를 누르면 필수 질문과 글자 수를 확인한 뒤 제출합니다. 제출한 뒤에는 고칠 수 없습니다.

같은 탭에서 새로고침하면 PIN을 다시 묻지 않고 이어서 씁니다. 탭을 닫으면 다음에는 PIN을 다시 입력해야 합니다.

## 관리 화면

- **질문 관리**: 모집 받기 켜기/끄기, 지원서 제목과 안내 문구, 질문 추가·수정·삭제·순서 바꾸기
  - 질문 유형: 단답형 / 장문형 / 객관식(하나) / 객관식(여러 개)
  - 필수 여부, 설명, 글자 수 제한(단답 기본 200자, 장문 기본 3000자), 객관식 보기
- **응답 현황**: 제출 완료/작성 중 인원, 검색, 지원서 보기, **엑셀(.xlsx) 다운로드**
  - 기본은 제출 완료만 내려받고, 체크하면 작성 중인 지원서도 넣습니다.
  - 지원서 보기 창에서 **PIN 초기화**(PIN을 잊은 사람), **제출 취소**(다시 고칠 수 있게), **삭제**를 할 수 있습니다.

## 서버 없이 미리 보기

주소 뒤에 `?demo=1`을 붙이면 서버 없이 이 브라우저 안에서만 동작합니다. 실제 DB에는 아무것도 저장되지 않습니다.

- `index.html?demo=1`: 데모 지원자 `minji.park`(작성 중), `younghee.kim`(제출 완료)이 있고 PIN은 `1234`입니다.
- `admin.html?demo=1`: 아무 비밀번호나 입력하면 들어갑니다.

VS Code에서 폴더를 연 뒤 Live Server 확장이나 `npx serve`로 띄워서 열면 됩니다.

## 처음 설정하기 (Supabase)

지원서 전용 Supabase 프로젝트(`ibxkogofileadudopvoc`)에 설정합니다.

1. **SQL 실행**: 대시보드 **SQL Editor → New query**에 [`supabase/apply.sql`](supabase/apply.sql) 내용을 전부 붙여 넣고 **Run**
   - `apply_forms`, `apply_questions`, `apply_applicants` 테이블과 지원자용 함수(`ap_*`)가 생깁니다.
   - 코드가 `apply`인 지원서 하나와 예시 질문 5개가 들어갑니다. 질문은 관리 화면에서 고치면 됩니다.
2. **Secret 추가**: **Edge Functions → Secrets**에 `APPLY_ADMIN_PASSWORD`를 추가합니다. (지원서 관리 화면 비밀번호)
3. **Edge Function 배포**: **Edge Functions → Deploy a new function → Via Editor**
   - 함수 이름: **`apply-admin`**
   - [`supabase/functions/apply-admin/index.ts`](supabase/functions/apply-admin/index.ts) 내용을 전부 붙여 넣고 **Deploy**
   - 배포한 함수의 설정에서 **Verify JWT를 끄고** 저장합니다. (비밀번호로 직접 확인하는 함수입니다)
4. **config.js**: 지원서 전용 프로젝트의 Project URL과 publishable 키가 이미 들어 있습니다. 다른 프로젝트를 쓸 때만 바꿉니다.

확인 (터미널, `[비밀번호]`를 바꿔서):

```bash
curl -s -X POST "https://ibxkogofileadudopvoc.supabase.co/functions/v1/apply-admin" -H "Content-Type: application/json" -d '{"password":"[비밀번호]","code":"apply","action":"verify"}'
```

`{"ok":true,"form":{...},"questions":[...]}`가 나오면 정상입니다.

## 배포 (GitHub Pages)

새 저장소(예: `genz-lab-apply`)를 GitHub에서 만든 뒤 이 폴더에서:

```bash
git init
git add -A
git commit -m "지원서 모집 페이지"
git branch -M main
git remote add origin https://github.com/<계정>/genz-lab-apply.git
git push -u origin main
```

저장소 **Settings → Pages**에서 Source를 "Deploy from a branch", 브랜치를 `main` / `(root)`로 두면 1~2분 뒤 열립니다.

- 지원서: `https://<계정>.github.io/genz-lab-apply/`
- 관리: `https://<계정>.github.io/genz-lab-apply/admin.html`

Edge Function을 고쳤을 때는 GitHub에 올리는 것만으로는 반영되지 않습니다. Supabase 대시보드 **Edge Functions → apply-admin → Code**에 다시 붙여 넣고 Deploy 해야 합니다.

## 지원서 여러 개 운영하기

`apply_forms`에 코드가 다른 줄을 추가하면 지원서를 따로 운영할 수 있습니다. 주소 뒤에 `?f=코드`를 붙여 엽니다(`index.html?f=2027`, `admin.html?f=2027`).

```sql
insert into public.apply_forms (code, title) values ('2027', '2027 지원서');
```

## 보안과 한계

- 지원서 내용, 이름, Knox ID는 공개 키로 직접 읽을 수 없습니다. 지원자는 PIN이 맞을 때만 자기 지원서를 읽고 쓰고, 담당자는 관리자 비밀번호를 거친 Edge Function으로만 봅니다.
- PIN은 bcrypt로 바꿔 저장하고, **5번 틀리면 10분 동안 잠깁니다**.
- Knox ID에 대한 별도 인증은 없습니다. 다른 사람의 Knox ID로 **먼저** 지원서를 시작할 수는 있습니다. 이상한 지원서는 관리 화면에서 지우면 됩니다.
- Knox ID만 적으면 그 ID가 "처음 / 작성 중 / 제출 완료" 중 어디인지는 알 수 있습니다(요청하신 "이미 응답하셨습니다" 안내 때문). 내용은 PIN 없이 보이지 않습니다.
- 질문을 지우면 그 질문의 답변은 DB에는 남지만 관리 화면과 엑셀에는 나오지 않습니다. 객관식 보기 글자를 바꾸면 이미 고른 답은 예전 글자로 남습니다.
- Supabase 무료 플랜은 7일 동안 사용이 없으면 일시정지됩니다. 모집 기간에는 지원자가 계속 들어오므로 보통 괜찮지만, 모집 시작 전에 대시보드에서 깨어 있는지 확인하세요.
