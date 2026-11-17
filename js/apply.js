// apply: 지원자 화면.
// Knox ID + 이름 → (처음) PIN 정하기 / (작성 중) PIN 입력 → 지원서 작성 → 제출
// 이미 제출한 Knox ID는 "이미 응답하셨습니다" 화면으로 갑니다.
(function () {
  const { code, demo, rpc, toast, when, limitOf, knoxOf } = window.AP;
  const $ = (id) => document.getElementById(id);

  const AUTOSAVE_MS = 60 * 1000;          // 1분마다 자동 임시 저장
  const SESSION_KEY = "ap-session:" + code; // 새로고침해도 이어서 쓰도록 이 탭에만 기억(탭을 닫으면 사라짐)
  const LAST_KEY = "ap-last";              // 다음에 들어올 때 Knox ID·이름을 미리 채워 둠

  let form = null;        // { title, intro, is_open, questions }
  let me = null;          // { knox_id, name, pin }
  let pinMode = "new";    // new: 처음 PIN 정하기 | reset: 초기화 뒤 새 PIN | enter: PIN 입력
  let answers = {};
  let dirty = false;      // 저장하지 않은 변경이 있는지
  let saving = false;
  let submitting = false;
  let savedAt = null;
  let saveError = "";
  let timer = null;

  const store = {
    get(storage, key) { try { return JSON.parse(storage.getItem(key)); } catch (e) { return null; } },
    set(storage, key, v) { try { v ? storage.setItem(key, JSON.stringify(v)) : storage.removeItem(key); } catch (e) { /* 무시 */ } },
  };

  // ── 화면 전환 ───────────────────────────────────────────────────
  function show(view) {
    document.querySelectorAll(".view").forEach((el) => { el.hidden = el.id !== "view-" + view; });
    $("action-bar").hidden = view !== "form";
    $("user").hidden = !me || view === "login";
    if (me) {
      $("user-name").textContent = me.name;
      $("user-knox").textContent = me.knox_id;
    }
    if (view !== "form") stopAutosave();
    window.scrollTo(0, 0);
  }

  function fatal(message) {
    $("loading-text").textContent = message;
    show("loading");
  }

  const setErr = (id, msg) => { $(id).textContent = msg || ""; $(id).hidden = !msg; };

  // ── 1단계: Knox ID · 이름 ───────────────────────────────────────
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const knox = knoxOf($("login-knox").value);
    const name = $("login-name").value.trim();
    if (!knox) return setErr("login-err", "Knox ID를 적어 주세요.");
    if (!name) return setErr("login-err", "이름을 적어 주세요.");
    setErr("login-err", "");
    const btn = $("login-btn");
    btn.disabled = true;
    btn.textContent = "확인하는 중…";
    try {
      const out = await rpc("ap_check", { p_code: code, p_knox_id: knox });
      if (!out.ok) throw new Error(out.message);
      me = { knox_id: out.knox_id, name, pin: null };
      store.set(localStorage, LAST_KEY, { knox: out.knox_id, name });
      form.is_open = out.is_open;
      if (out.state === "submitted") return showAlready();
      if (out.state === "new" && !out.is_open) return show("closed");
      openPin(out.state === "draft" ? "enter" : out.state); // new | reset | enter
    } catch (err) {
      setErr("login-err", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "다음";
    }
  });

  // ── 2단계: PIN ──────────────────────────────────────────────────
  function openPin(mode) {
    pinMode = mode;
    const entering = mode === "enter";
    $("pin-heading").innerHTML = entering ? "임시 저장한<br>지원서가 있어요" : "PIN 4자리를<br>정해 주세요";
    $("pin-desc").textContent = entering
      ? "처음에 정한 PIN 4자리를 입력하면 저장한 내용을 불러와요."
      : mode === "reset"
        ? "담당자가 PIN을 초기화했어요. 새 PIN을 정하면 작성하던 내용을 그대로 불러와요."
        : "임시 저장한 지원서를 다시 불러올 때 쓰는 번호예요. 잊지 않도록 기억해 두세요.";
    $("pin1-label").textContent = entering ? "PIN 4자리" : "새 PIN 4자리";
    $("pin2-row").hidden = entering;
    $("pin-btn").textContent = entering ? "불러오기" : "지원서 쓰기";
    $("pin-help").textContent = entering ? "PIN이 기억나지 않으면 담당자에게 PIN 초기화를 요청해 주세요." : "숫자 4자리 · 생일이나 1234처럼 쉬운 번호는 피해 주세요.";
    $("pin1").value = "";
    $("pin2").value = "";
    setErr("pin-err", "");
    show("pin");
    $("pin1").focus();
  }

  ["pin1", "pin2"].forEach((id) => $(id).addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, "").slice(0, 4);
  }));

  $("pin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = $("pin1").value;
    if (!/^[0-9]{4}$/.test(pin)) return setErr("pin-err", "PIN은 숫자 4자리로 입력해 주세요.");
    if (pinMode !== "enter" && pin !== $("pin2").value) return setErr("pin-err", "두 PIN이 서로 달라요. 다시 확인해 주세요.");
    setErr("pin-err", "");
    const btn = $("pin-btn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "확인하는 중…";
    try {
      const out = pinMode === "enter"
        ? await rpc("ap_load", { p_code: code, p_knox_id: me.knox_id, p_pin: pin })
        : await rpc("ap_start", { p_code: code, p_knox_id: me.knox_id, p_name: me.name, p_pin: pin });
      if (!out.ok) {
        if (out.error === "submitted") return showAlready();
        if (out.error === "closed") return show("closed");
        if (out.error === "exists") return openPin("enter");
        if (out.error === "no_pin") return openPin("reset");
        throw new Error(out.message);
      }
      me.pin = pin;
      store.set(sessionStorage, SESSION_KEY, { knox: me.knox_id, name: me.name, pin });
      afterLoad(out, pinMode === "enter");
    } catch (err) {
      setErr("pin-err", err.message);
      $("pin1").value = "";
      $("pin2").value = "";
      $("pin1").focus();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  $("pin-back").addEventListener("click", () => restart(false));
  document.querySelectorAll("[data-restart]").forEach((b) => b.addEventListener("click", () => restart(false)));

  // 서버에서 받은 내 지원서로 화면을 엽니다.
  function afterLoad(out, loaded) {
    form.is_open = out.is_open;
    if (out.status === "submitted") return showAlready();
    // 불러온 경우에는 처음에 적어 둔 이름을 씁니다. (방금 적은 이름이 다르면 저장할 때 바뀝니다)
    if (loaded && out.name && !me.name) me.name = out.name;
    answers = out.answers && typeof out.answers === "object" ? out.answers : {};
    savedAt = out.saved_at;
    dirty = false;
    saveError = "";
    renderForm();
    show("form");
    startAutosave();
    if (loaded && out.saved_at) toast(when(out.saved_at) + "에 저장한 내용을 불러왔어요");
  }

  function showAlready() {
    store.set(sessionStorage, SESSION_KEY, null);
    $("already-knox").textContent = me ? me.knox_id : "";
    show("already");
  }

  function restart(ask) {
    if (ask && dirty && !confirm("저장하지 않은 내용이 있어요. 그래도 처음으로 돌아갈까요?")) return;
    stopAutosave();
    store.set(sessionStorage, SESSION_KEY, null);
    me = null;
    answers = {};
    dirty = false;
    show("login");
  }
  $("user").addEventListener("click", async () => {
    if (!confirm("다른 Knox ID로 다시 시작할까요?" + (dirty ? "\n지금까지 쓴 내용은 먼저 임시 저장할게요." : ""))) return;
    if (dirty) await save("manual");
    restart(true);
  });

  // ── 3단계: 지원서 ───────────────────────────────────────────────
  function renderForm() {
    const box = $("questions");
    box.innerHTML = "";
    const locked = !form.is_open;
    $("closed-banner").hidden = !locked;

    form.questions.forEach((q, i) => {
      const card = document.createElement("div");
      card.className = "glass q";
      card.id = "q-" + q.id;

      const head = document.createElement("div");
      head.className = "q-head";
      const no = document.createElement("span");
      no.className = "q-no";
      no.textContent = "Q" + (i + 1);
      const title = document.createElement("label");
      title.className = "q-title";
      title.textContent = q.title;
      if (q.required) {
        const r = document.createElement("span");
        r.className = "req";
        r.textContent = "*";
        r.setAttribute("aria-label", "필수");
        title.appendChild(r);
      } else {
        const r = document.createElement("span");
        r.className = "opt-tag";
        r.textContent = "선택";
        title.appendChild(r);
      }
      head.append(no, title);
      card.appendChild(head);

      if (q.description) {
        const d = document.createElement("p");
        d.className = "q-desc";
        d.textContent = q.description;
        card.appendChild(d);
      }

      const inputId = "in-" + q.id;
      if (q.type === "short" || q.type === "long") {
        title.htmlFor = inputId;
        const max = limitOf(q);
        const el = document.createElement(q.type === "short" ? "input" : "textarea");
        el.className = "field";
        el.id = inputId;
        if (q.type === "short") el.type = "text";
        else el.rows = 6;
        el.value = typeof answers[q.id] === "string" ? answers[q.id] : "";
        el.disabled = locked;
        el.setAttribute("aria-required", String(!!q.required));
        el.placeholder = q.type === "short" ? "답변을 적어 주세요" : "답변을 자유롭게 적어 주세요";
        const counter = document.createElement("div");
        counter.className = "counter";
        const count = () => {
          const n = el.value.length;
          counter.textContent = n.toLocaleString() + " / " + max.toLocaleString() + "자";
          counter.classList.toggle("over", n > max);
        };
        el.addEventListener("input", () => {
          answers[q.id] = el.value;
          count();
          touched(card);
        });
        if (q.type === "long") {
          const grow = () => { el.style.height = "auto"; el.style.height = Math.max(el.scrollHeight + 2, 150) + "px"; };
          el.addEventListener("input", grow);
          requestAnimationFrame(grow);
        }
        count();
        card.append(el, counter);
      } else {
        const multi = q.type === "multi";
        const group = document.createElement("div");
        group.className = "opts" + ((q.options || []).every((o) => o.length <= 14) ? " grid" : "");
        group.setAttribute("role", multi ? "group" : "radiogroup");
        group.setAttribute("aria-label", q.title);
        const current = answers[q.id];
        (q.options || []).forEach((opt, k) => {
          const label = document.createElement("label");
          label.className = "opt";
          const input = document.createElement("input");
          input.type = multi ? "checkbox" : "radio";
          input.name = inputId;
          input.value = opt;
          input.disabled = locked;
          input.checked = multi ? Array.isArray(current) && current.includes(opt) : current === opt;
          if (k === 0) input.id = inputId;
          input.addEventListener("change", () => {
            if (multi) {
              answers[q.id] = [...group.querySelectorAll("input:checked")].map((x) => x.value);
            } else {
              answers[q.id] = opt;
            }
            touched(card);
          });
          const span = document.createElement("span");
          span.textContent = opt;
          label.append(input, span);
          group.appendChild(label);
        });
        if (multi) {
          const hint = document.createElement("p");
          hint.className = "q-desc small";
          hint.textContent = "여러 개 고를 수 있어요.";
          card.appendChild(hint);
        }
        card.appendChild(group);
      }

      box.appendChild(card);
    });

    if (!form.questions.length) {
      const empty = document.createElement("div");
      empty.className = "glass card";
      empty.textContent = "아직 질문이 없어요. 잠시 뒤 다시 들어와 주세요.";
      box.appendChild(empty);
    }
    renderStatus();
  }

  function touched(card) {
    dirty = true;
    saveError = "";
    card.classList.remove("invalid");
    renderStatus();
  }

  function renderStatus() {
    const locked = !form || !form.is_open;
    let text;
    if (locked) text = "모집이 마감되었어요";
    else if (saving) text = "저장하는 중…";
    else if (saveError) text = saveError;
    else if (dirty) text = "저장하지 않은 변경이 있어요 · 1분마다 자동 저장돼요";
    else if (savedAt) text = "임시 저장됨 · " + when(savedAt);
    else text = "작성 중에는 1분마다 자동으로 임시 저장돼요";
    $("save-status").textContent = text;
    $("save-status").classList.toggle("warn", !!saveError);
    $("save-btn").disabled = locked || saving || submitting;
    $("submit-btn").disabled = locked || submitting;
    $("save-btn").textContent = saving ? "저장 중…" : "임시 저장";
    $("submit-btn").textContent = submitting ? "제출하는 중…" : "제출하기";
  }

  // 지금 답변을 복사해서 보냅니다.
  const payload = () => JSON.parse(JSON.stringify(answers));

  // 서버가 거절했을 때 공통 처리. 처리했으면 true
  function handleRejection(out) {
    if (out.error === "submitted") { showAlready(); return true; }
    if (out.error === "closed") {
      form.is_open = false;
      renderForm();
      toast(out.message);
      return true;
    }
    if (out.error === "no_pin" || out.error === "wrong_pin" || out.error === "locked" || out.error === "not_found") {
      // 관리자가 PIN을 초기화했거나 지원서를 지운 경우
      stopAutosave();
      store.set(sessionStorage, SESSION_KEY, null);
      toast(out.message);
      if (out.error === "not_found") restart(false);
      else openPin(out.error === "no_pin" ? "reset" : "enter");
      return true;
    }
    return false;
  }

  async function save(kind) {
    if (!me || !me.pin || saving || submitting || !form.is_open) return false;
    if (kind === "auto" && !dirty) return true;
    saving = true;
    renderStatus();
    const sent = JSON.stringify(answers);
    try {
      const out = await rpc("ap_save", { p_code: code, p_knox_id: me.knox_id, p_pin: me.pin, p_name: me.name, p_answers: payload() });
      if (!out.ok) {
        if (handleRejection(out)) return false;
        throw new Error(out.message);
      }
      savedAt = out.saved_at;
      if (JSON.stringify(answers) === sent) dirty = false; // 저장하는 사이 새로 쓴 내용은 다음에 저장
      saveError = "";
      if (kind === "manual") toast("임시 저장했어요");
      return true;
    } catch (err) {
      saveError = (kind === "auto" ? "자동 저장 실패 · " : "저장 실패 · ") + err.message;
      if (kind === "manual") toast("저장하지 못했어요. " + err.message);
      return false;
    } finally {
      saving = false;
      renderStatus();
    }
  }

  function startAutosave() {
    stopAutosave();
    timer = setInterval(() => { save("auto"); }, AUTOSAVE_MS);
  }
  function stopAutosave() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  $("save-btn").addEventListener("click", () => save("manual"));

  // 빠진 필수 질문이나 글자 수 초과를 찾아 표시합니다.
  function firstProblem() {
    document.querySelectorAll(".q.invalid").forEach((el) => el.classList.remove("invalid"));
    for (const q of form.questions) {
      const v = answers[q.id];
      let msg = "";
      if (q.type === "multi") {
        if (q.required && !(Array.isArray(v) && v.length)) msg = "하나 이상 골라 주세요";
      } else {
        const t = typeof v === "string" ? v.trim() : "";
        if (q.required && !t) msg = q.type === "single" ? "하나를 골라 주세요" : "답변을 적어 주세요";
        else if (q.type !== "single" && t.length > limitOf(q)) msg = limitOf(q) + "자까지 쓸 수 있어요";
      }
      if (msg) return { id: q.id, message: "Q" + (form.questions.indexOf(q) + 1) + ". " + msg };
    }
    return null;
  }

  function flag(id, message) {
    const card = $("q-" + id);
    if (!card) return toast(message);
    card.classList.add("invalid");
    card.scrollIntoView({ behavior: "smooth", block: "start" });
    const input = card.querySelector("input, textarea");
    if (input) setTimeout(() => input.focus({ preventScroll: true }), 400);
    toast(message);
  }

  $("submit-btn").addEventListener("click", async () => {
    if (submitting || !form.is_open) return;
    const problem = firstProblem();
    if (problem) return flag(problem.id, problem.message);
    if (!confirm("지원서를 제출할까요?\n제출한 뒤에는 내용을 고칠 수 없어요.")) return;
    submitting = true;
    renderStatus();
    try {
      const out = await rpc("ap_submit", { p_code: code, p_knox_id: me.knox_id, p_pin: me.pin, p_name: me.name, p_answers: payload() });
      if (!out.ok) {
        if (out.question) return flag(out.question, out.message);
        if (handleRejection(out)) return;
        throw new Error(out.message);
      }
      dirty = false;
      store.set(sessionStorage, SESSION_KEY, null);
      $("done-desc").innerHTML = "";
      $("done-desc").append(me.name + "님, 지원해 주셔서 고마워요.", document.createElement("br"),
        "제출 시각 · " + when(out.submitted_at));
      show("done");
    } catch (err) {
      toast("제출하지 못했어요. " + err.message);
    } finally {
      submitting = false;
      renderStatus();
    }
  });

  // 다른 앱으로 넘어가거나 탭을 숨기면 바로 저장해 둡니다(모바일에서 잃어버리지 않게).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && dirty && timer) save("auto");
  });
  window.addEventListener("beforeunload", (e) => {
    if (dirty && timer) { e.preventDefault(); e.returnValue = ""; }
  });

  // ── 시작 ────────────────────────────────────────────────────────
  async function start() {
    $("demo-banner").hidden = !demo;
    let out;
    try {
      out = await rpc("ap_form", { p_code: code });
    } catch (err) {
      return fatal("지원서를 불러오지 못했어요. " + err.message);
    }
    if (!out.ok) return fatal(out.message);
    form = out;
    document.title = form.title + " · Gen Z Lab.";
    document.querySelectorAll(".form-title").forEach((el) => { el.textContent = form.title; });
    $("form-intro").textContent = form.intro || "";
    $("form-intro").hidden = !form.intro;

    const last = store.get(localStorage, LAST_KEY);
    if (last) {
      $("login-knox").value = last.knox || "";
      $("login-name").value = last.name || "";
    }

    // 같은 탭에서 새로고침한 경우: PIN을 다시 묻지 않고 이어서 씁니다.
    const saved = store.get(sessionStorage, SESSION_KEY);
    if (saved && saved.knox && saved.pin) {
      try {
        const st = await rpc("ap_load", { p_code: code, p_knox_id: saved.knox, p_pin: saved.pin });
        if (st.ok) {
          me = { knox_id: st.knox_id, name: saved.name || st.name, pin: saved.pin };
          return afterLoad(st, false);
        }
      } catch (e) { /* 아래에서 처음부터 */ }
      store.set(sessionStorage, SESSION_KEY, null);
    }
    show("login");
  }

  start();
})();
