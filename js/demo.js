// 미리보기(?demo=1)용 가짜 서버. 이 브라우저의 localStorage 에만 저장합니다.
// index.html?demo=1 과 admin.html?demo=1 이 같은 데이터를 봅니다. 서버 규칙(supabase/apply.sql)을 흉내 냅니다.
// 데모 관리자 비밀번호는 아무 값이나 됩니다. 데모 지원자 PIN은 1234 입니다.
(function () {
  const KEY = "ap-demo-v1";
  const now = () => new Date().toISOString();
  const uid = () => Math.random().toString(36).slice(2, 10);
  const fail = (error, message, extra) => Object.assign({ ok: false, error, message }, extra);
  const knoxOf = (s) => String(s || "").trim().toLowerCase().split("@")[0];
  const limitOf = (q) => q.max_length || (q.type === "short" ? 200 : 3000);

  function seed() {
    const q = (type, title, description, options, required, max_length) =>
      ({ id: uid(), type, title, description, options, required, max_length });
    const questions = [
      q("short", "소속 부서", "", [], true, 50),
      q("long", "지원 동기", "Gen Z Lab.에 지원하는 이유를 자유롭게 적어 주세요.", [], true, 1000),
      q("single", "가장 관심 있는 활동", "", ["프로그램 기획", "콘텐츠 제작", "운영·진행", "디자인"], true, null),
      q("multi", "참여 가능한 요일", "해당하는 요일을 모두 골라 주세요.", ["월", "화", "수", "목", "금"], true, null),
      q("long", "하고 싶은 말", "", [], false, 500),
    ];
    const [dept, why, area, days] = questions.map((x) => x.id);
    const t = (m) => new Date(Date.now() - m * 60000).toISOString();
    const person = (knox_id, name, status, answers, m) => ({
      knox_id, name, pin: "1234", status, answers, failed: 0,
      created_at: t(m + 30), saved_at: t(m), submitted_at: status === "submitted" ? t(m) : null,
    });
    return {
      form: { id: "demo", code: "apply", title: "Gen Z Lab. 지원서", is_open: true,
        intro: "아래 질문에 답해 주세요. 작성 중에는 1분마다 자동으로 임시 저장되고, 제출한 뒤에는 고칠 수 없어요." },
      questions,
      applicants: [
        person("younghee.kim", "김영희", "submitted",
          { [dept]: "DX 기획팀", [why]: "새로운 세대와 함께 일하는 방식을 고민해 보고 싶어서 지원했습니다.\n특히 사내 소통 프로그램에 관심이 많습니다.", [area]: "프로그램 기획", [days]: ["화", "목"] }, 120),
        person("chulsoo.lee", "이철수", "submitted",
          { [dept]: "인사팀", [why]: "작년 워크샵이 정말 좋았어요.", [area]: "운영·진행", [days]: ["월", "수", "금"] }, 45),
        person("minji.park", "박민지", "draft", { [dept]: "디자인그룹", [why]: "작성 중…" }, 5),
      ],
    };
  }

  const load = () => {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.form) return s; } catch (e) { /* 새로 만듦 */ }
    const s = seed();
    save(s);
    return s;
  };
  const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* 무시 */ } };
  const wait = () => new Promise((r) => setTimeout(r, 250));

  const stateOf = (s, a) => ({
    ok: true, knox_id: a.knox_id, name: a.name, status: a.status, answers: a.answers,
    saved_at: a.saved_at, submitted_at: a.submitted_at, is_open: s.form.is_open,
  });

  function checkPin(a, pin) {
    if (!a) return fail("not_found", "작성 중인 지원서를 찾지 못했어요. 처음부터 다시 시도해 주세요.");
    if (!a.pin) return fail("no_pin", "PIN이 초기화됐어요. 새 PIN을 정해 주세요.");
    if (a.pin !== pin) {
      a.failed = (a.failed || 0) + 1;
      return fail("wrong_pin", "PIN이 맞지 않아요. " + Math.max(0, 5 - a.failed) + "번 더 틀리면 10분 동안 잠겨요.");
    }
    a.failed = 0;
    return null;
  }

  function validate(s, answers) {
    for (const q of s.questions) {
      const v = answers[q.id];
      if (q.type === "multi") {
        if (q.required && !(Array.isArray(v) && v.length)) return fail("required", '"' + q.title + '" 질문에서 하나 이상 골라 주세요.', { question: q.id });
      } else {
        const t = typeof v === "string" ? v.trim() : "";
        if (q.required && !t) return fail("required", '"' + q.title + '" 질문에 답해 주세요.', { question: q.id });
        if (q.type !== "single" && t.length > limitOf(q)) return fail("too_long", '"' + q.title + '" 답변은 ' + limitOf(q) + "자까지 쓸 수 있어요.", { question: q.id });
      }
    }
    return null;
  }

  async function rpc(name, args) {
    await wait();
    const s = load();
    const knox = knoxOf(args.p_knox_id);
    const a = s.applicants.find((x) => x.knox_id === knox);
    let out;
    switch (name) {
      case "ap_form":
        out = { ok: true, title: s.form.title, intro: s.form.intro, is_open: s.form.is_open, questions: s.questions };
        break;
      case "ap_check":
        out = { ok: true, knox_id: knox, is_open: s.form.is_open,
          state: !a ? "new" : a.status === "submitted" ? "submitted" : !a.pin ? "reset" : "draft" };
        break;
      case "ap_start": {
        const n = String(args.p_name || "").trim();
        if (!/^[0-9]{4}$/.test(args.p_pin || "")) { out = fail("bad_pin", "PIN은 숫자 4자리로 정해 주세요."); break; }
        if (!a) {
          if (!s.form.is_open) { out = fail("closed", "모집이 마감되었어요."); break; }
          const row = { knox_id: knox, name: n, pin: args.p_pin, status: "draft", answers: {}, failed: 0, created_at: now(), saved_at: null, submitted_at: null };
          s.applicants.push(row);
          out = stateOf(s, row);
        } else if (a.status === "submitted") out = fail("submitted", "이미 응답하셨습니다.");
        else if (!a.pin) { a.pin = args.p_pin; a.name = n; out = stateOf(s, a); }
        else out = fail("exists", "이미 작성 중인 지원서가 있어요. PIN으로 불러와 주세요.");
        break;
      }
      case "ap_load":
        out = checkPin(a, args.p_pin) || stateOf(s, a);
        break;
      case "ap_save":
      case "ap_submit": {
        out = checkPin(a, args.p_pin);
        if (out) break;
        if (a.status === "submitted") { out = fail("submitted", "이미 응답하셨습니다."); break; }
        if (!s.form.is_open) { out = fail("closed", "모집이 마감되어 " + (name === "ap_save" ? "저장" : "제출") + "할 수 없어요."); break; }
        if (name === "ap_submit") { out = validate(s, args.p_answers); if (out) break; }
        a.answers = args.p_answers;
        if (String(args.p_name || "").trim()) a.name = String(args.p_name).trim();
        a.saved_at = now();
        if (name === "ap_submit") { a.status = "submitted"; a.submitted_at = now(); }
        out = stateOf(s, a);
        break;
      }
      default:
        throw new Error("알 수 없는 함수: " + name);
    }
    save(s);
    return JSON.parse(JSON.stringify(out));
  }

  async function admin(action, body) {
    await wait();
    const s = load();
    const list = () => s.applicants.map(({ pin, failed, ...rest }) => Object.assign({}, rest, { has_pin: !!pin, locked_until: null }));
    const find = () => s.applicants.find((x) => x.knox_id === String(body.knox_id || "").toLowerCase());
    let out;
    switch (action) {
      case "verify":
      case "form":
        out = { ok: true, form: s.form, questions: s.questions };
        break;
      case "form_update":
        if (typeof body.title === "string") s.form.title = body.title.trim() || s.form.title;
        if (typeof body.intro === "string") s.form.intro = body.intro.trim();
        if (typeof body.is_open === "boolean") s.form.is_open = body.is_open;
        out = { ok: true, form: s.form, questions: s.questions };
        break;
      case "question_save": {
        const q = body.question;
        if (!String(q.title || "").trim()) throw new Error("질문은 1~200자로 적어 주세요");
        const choice = q.type === "single" || q.type === "multi";
        const options = choice ? [...new Set((q.options || []).map((o) => String(o).trim()).filter(Boolean))] : [];
        if (choice && options.length < 2) throw new Error("보기를 2개 이상 적어 주세요");
        const clean = { type: q.type, title: q.title.trim(), description: (q.description || "").trim(), options,
          required: q.required !== false, max_length: !choice && q.max_length ? Number(q.max_length) : null };
        const cur = q.id && s.questions.find((x) => x.id === q.id);
        if (cur) Object.assign(cur, clean);
        else s.questions.push(Object.assign({ id: uid() }, clean));
        out = { ok: true, form: s.form, questions: s.questions };
        break;
      }
      case "question_delete":
        s.questions = s.questions.filter((x) => x.id !== body.id);
        out = { ok: true, form: s.form, questions: s.questions };
        break;
      case "question_move":
        s.questions = body.ids.map((id) => s.questions.find((x) => x.id === id)).filter(Boolean);
        out = { ok: true, form: s.form, questions: s.questions };
        break;
      case "responses":
        out = { ok: true, form: s.form, questions: s.questions, applicants: list() };
        break;
      case "applicant_reset_pin": { const a = find(); if (a) { a.pin = null; a.failed = 0; } out = { ok: true, applicants: list() }; break; }
      case "applicant_reopen": { const a = find(); if (a) { a.status = "draft"; a.submitted_at = null; } out = { ok: true, applicants: list() }; break; }
      case "applicant_delete":
        s.applicants = s.applicants.filter((x) => x.knox_id !== String(body.knox_id || "").toLowerCase());
        out = { ok: true, applicants: list() };
        break;
      case "demo_reset":
        localStorage.removeItem(KEY);
        return admin("responses", {});
      default:
        throw new Error("알 수 없는 동작입니다");
    }
    save(s);
    return JSON.parse(JSON.stringify(out));
  }

  window.APDemo = { rpc, admin };
})();
