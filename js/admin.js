// admin: 지원서 관리 화면. 모든 동작은 Edge Function(apply-admin)을 거칩니다.
(function () {
  const AP = window.AP;
  const { toast, when, stamp, TYPE_LABEL } = AP;
  const $ = (id) => document.getElementById(id);

  let password = null;   // 메모리에만 보관. 새로고침하면 다시 입력합니다.
  let form = null;
  let questions = [];
  let applicants = [];
  let loadedResponses = false;
  let busy = false;
  let editing = null;    // 수정 중인 질문 (새 질문이면 {})
  let edType = "short";
  let filter = "all";
  let current = null;    // 보기 창에 띄운 지원자 knox_id
  let formDirty = false;

  const api = (action, extra) => AP.admin(password, action, extra);

  // 버튼을 잠그고 서버를 부릅니다. 실패하면 알림만 띄우고 null
  async function call(action, extra, button) {
    if (busy) return null;
    busy = true;
    if (button) button.disabled = true;
    try {
      const out = await api(action, extra);
      if (out.form) form = out.form;
      if (out.questions) questions = out.questions;
      if (out.applicants) { applicants = out.applicants; loadedResponses = true; }
      render();
      return out;
    } catch (err) {
      toast(err.message);
      return null;
    } finally {
      busy = false;
      if (button) button.disabled = false;
    }
  }

  // ── 로그인 ──────────────────────────────────────────────────────
  if (AP.demo) $("login-note").textContent = "미리보기 모드: 아무 비밀번호나 들어갈 수 있어요.";
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("login-btn");
    btn.disabled = true;
    btn.textContent = "확인하는 중…";
    $("login-err").hidden = true;
    password = $("pw").value;
    try {
      const out = await api("verify");
      form = out.form;
      questions = out.questions;
      $("pw").value = "";
      enter();
    } catch (err) {
      password = null;
      $("login-err").textContent = err.message;
      $("login-err").hidden = false;
    }
    btn.disabled = false;
    btn.textContent = "들어가기";
  });

  function enter() {
    $("login").hidden = true;
    $("panel").hidden = false;
    $("demo-pill").hidden = !AP.demo;
    const qs = new URLSearchParams();
    if (new URLSearchParams(location.search).get("f")) qs.set("f", AP.code);
    if (AP.demo) qs.set("demo", "1");
    $("link-apply").href = "./" + (qs.toString() ? "?" + qs : "");
    render();
    refreshResponses();
    // 응답은 실시간 알림이 없어서 30초마다 다시 읽습니다.
    setInterval(() => { if (!document.hidden) refreshResponses(); }, 30000);
    const first = new URLSearchParams(location.search).get("tab");
    if (first && $("tab-" + first)) showTab(first);
  }

  async function refreshResponses() {
    try {
      const out = await api("responses");
      form = out.form;
      questions = out.questions;
      applicants = out.applicants;
      loadedResponses = true;
      render();
    } catch (err) {
      toast("응답을 불러오지 못했어요: " + err.message);
    }
  }

  // ── 탭 ──────────────────────────────────────────────────────────
  function showTab(name) {
    document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === name)));
    document.querySelectorAll(".tabpane").forEach((p) => { p.hidden = p.id !== "tab-" + name; });
    if (name === "responses") refreshResponses();
  }
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ── 그리기 ──────────────────────────────────────────────────────
  function render() {
    if (!form) return;
    const open = form.is_open;
    $("dot").classList.toggle("off", !open);
    $("status-text").textContent = open ? "모집 중" : "모집 마감";
    $("open-toggle").setAttribute("aria-pressed", String(open));
    $("open-hint").textContent = open
      ? "지금 지원서를 쓰고 저장·제출할 수 있어요."
      : "마감했어요. 새로 시작하거나 저장·제출할 수 없어요. (이미 제출한 지원서는 그대로)";
    if (!formDirty) {
      $("f-title").value = form.title;
      $("f-intro").value = form.intro || "";
    }
    renderQuestions();
    renderResponses();
  }

  function renderQuestions() {
    $("q-count").textContent = questions.length + "개";
    const list = $("q-list");
    list.innerHTML = "";
    if (!questions.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "아직 질문이 없어요. 오른쪽 위 \"질문 추가\"를 눌러 주세요.";
      list.appendChild(empty);
    }
    questions.forEach((q, i) => {
      const item = document.createElement("div");
      item.className = "qitem" + (editing && editing.id === q.id ? " editing" : "");

      const body = document.createElement("div");
      body.className = "qbody";
      const meta = document.createElement("div");
      meta.className = "meta";
      const no = document.createElement("b");
      no.className = "no";
      no.textContent = "Q" + (i + 1);
      const type = document.createElement("span");
      type.className = "tag type";
      type.textContent = TYPE_LABEL[q.type];
      const req = document.createElement("span");
      req.className = "tag" + (q.required ? " req" : "");
      req.textContent = q.required ? "필수" : "선택";
      meta.append(no, type, req);
      if ((q.type === "short" || q.type === "long") && q.max_length) {
        const lim = document.createElement("span");
        lim.className = "tag";
        lim.textContent = q.max_length + "자";
        meta.appendChild(lim);
      }
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = q.title;
      body.append(meta, t);
      if (q.description) {
        const d = document.createElement("div");
        d.className = "d";
        d.textContent = q.description;
        body.appendChild(d);
      }
      if (q.options && q.options.length) {
        const opts = document.createElement("div");
        opts.className = "opts";
        q.options.forEach((o) => {
          const s = document.createElement("span");
          s.textContent = o;
          opts.appendChild(s);
        });
        body.appendChild(opts);
      }

      const acts = document.createElement("div");
      acts.className = "acts";
      const btn = (label, title, fn, cls) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn ghost " + (cls || "");
        b.textContent = label;
        b.title = title;
        b.setAttribute("aria-label", "Q" + (i + 1) + " " + title);
        b.addEventListener("click", () => fn(b));
        acts.appendChild(b);
        return b;
      };
      btn("↑", "위로", (b) => move(i, -1, b), "icon").disabled = i === 0;
      btn("↓", "아래로", (b) => move(i, 1, b), "icon").disabled = i === questions.length - 1;
      btn("수정", "수정", () => openEditor(q));
      btn("삭제", "삭제", (b) => {
        if (!confirm("Q" + (i + 1) + ". " + q.title + "\n\n이 질문을 지울까요? 이미 받은 이 질문의 답변은 엑셀에 나오지 않게 돼요.")) return;
        call("question_delete", { id: q.id }, b).then((out) => { if (out) toast("질문을 지웠어요"); });
      }, "danger-text");

      item.append(body, acts);
      list.appendChild(item);
    });
  }

  function move(i, dir, button) {
    const ids = questions.map((q) => q.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    call("question_move", { ids }, button);
  }

  // ── 질문 편집기 ─────────────────────────────────────────────────
  function setType(type) {
    edType = type;
    document.querySelectorAll("#ed-type button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.type === type)));
    const choice = type === "single" || type === "multi";
    $("ed-options-row").hidden = !choice;
    $("ed-max-row").hidden = choice;
    $("ed-max").placeholder = type === "short" ? "비우면 200자" : "비우면 3000자";
  }
  document.querySelectorAll("#ed-type button").forEach((b) => b.addEventListener("click", () => setType(b.dataset.type)));

  function openEditor(q) {
    editing = q || {};
    $("ed-heading").textContent = q ? "질문 수정" : "새 질문";
    setType(q ? q.type : "short");
    $("ed-title").value = q ? q.title : "";
    $("ed-desc").value = q ? q.description || "" : "";
    $("ed-options").value = q && q.options ? q.options.join("\n") : "";
    $("ed-max").value = q && q.max_length ? q.max_length : "";
    $("ed-required").checked = q ? q.required : true;
    $("ed-err").hidden = true;
    $("editor").hidden = false;
    renderQuestions();
    $("editor").scrollIntoView({ behavior: "smooth", block: "nearest" });
    $("ed-title").focus({ preventScroll: true });
  }
  function closeEditor() {
    editing = null;
    $("editor").hidden = true;
    renderQuestions();
  }
  $("q-add").addEventListener("click", () => openEditor(null));
  $("ed-cancel").addEventListener("click", closeEditor);

  $("editor").addEventListener("submit", async (e) => {
    e.preventDefault();
    const choice = edType === "single" || edType === "multi";
    const question = {
      id: editing && editing.id ? editing.id : undefined,
      type: edType,
      title: $("ed-title").value.trim(),
      description: $("ed-desc").value.trim(),
      options: choice ? $("ed-options").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [],
      required: $("ed-required").checked,
      max_length: !choice && $("ed-max").value ? Number($("ed-max").value) : null,
    };
    const err = !question.title ? "질문을 적어 주세요."
      : choice && new Set(question.options).size < 2 ? "보기를 서로 다르게 2개 이상 적어 주세요."
      : question.max_length != null && !(question.max_length >= 1 && question.max_length <= 5000) ? "글자 수 제한은 1~5000 사이로 적어 주세요."
      : "";
    if (err) {
      $("ed-err").textContent = err;
      $("ed-err").hidden = false;
      return;
    }
    const wasNew = !question.id;
    const out = await call("question_save", { question }, $("ed-save"));
    if (out) {
      closeEditor();
      toast(wasNew ? "질문을 추가했어요" : "질문을 고쳤어요");
    }
  });

  // ── 지원서 정보 · 모집 ──────────────────────────────────────────
  ["f-title", "f-intro"].forEach((id) => $(id).addEventListener("input", () => { formDirty = true; }));
  $("f-save").addEventListener("click", async (e) => {
    const title = $("f-title").value.trim();
    if (!title) return toast("제목을 적어 주세요");
    const out = await call("form_update", { title, intro: $("f-intro").value }, e.currentTarget);
    if (out) { formDirty = false; render(); toast("지원서 정보를 저장했어요"); }
  });
  $("open-toggle").addEventListener("click", async (e) => {
    const next = !form.is_open;
    if (!next && !confirm("모집을 마감할까요?\n작성 중인 사람도 더 이상 저장·제출할 수 없게 돼요.")) return;
    const out = await call("form_update", { is_open: next }, e.currentTarget);
    if (out) toast(next ? "모집을 다시 열었어요" : "모집을 마감했어요");
  });

  // ── 응답 현황 ───────────────────────────────────────────────────
  document.querySelectorAll("#r-filter button").forEach((b) => b.addEventListener("click", () => {
    filter = b.dataset.filter;
    document.querySelectorAll("#r-filter button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderResponses();
  }));
  $("r-search").addEventListener("input", renderResponses);
  $("r-refresh").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    await refreshResponses();
    btn.disabled = false;
    toast("새로 불러왔어요");
  });

  function renderResponses() {
    const done = applicants.filter((a) => a.status === "submitted");
    const draft = applicants.filter((a) => a.status !== "submitted");
    $("r-done").textContent = done.length + "명";
    $("r-draft").textContent = draft.length + "명";
    $("tab-count").textContent = loadedResponses ? "· " + done.length : "";
    const locked = applicants.filter((a) => !a.has_pin).length;
    $("r-note").textContent = "전체 " + applicants.length + "명" + (locked ? " · PIN 초기화 상태 " + locked + "명" : "");

    const q = $("r-search").value.trim().toLowerCase();
    const rows = applicants
      .filter((a) => filter === "all" || (filter === "submitted" ? a.status === "submitted" : a.status !== "submitted"))
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.knox_id.includes(q))
      .sort((a, b) => String(b.submitted_at || b.saved_at || b.created_at).localeCompare(String(a.submitted_at || a.saved_at || a.created_at)));

    const list = $("r-list");
    list.innerHTML = "";
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = !loadedResponses ? "불러오는 중…" : applicants.length ? "조건에 맞는 지원자가 없어요." : "아직 지원자가 없어요.";
      list.appendChild(empty);
    }
    rows.forEach((a) => {
      const tr = document.createElement("div");
      tr.className = "tr resp";
      const name = document.createElement("span");
      name.className = "w";
      name.textContent = a.name;
      const knox = document.createElement("span");
      knox.className = "k";
      knox.textContent = a.knox_id;
      const st = document.createElement("span");
      const badge = document.createElement("span");
      badge.className = "badge " + (a.status === "submitted" ? "done" : "draft");
      badge.textContent = a.status === "submitted" ? "제출 완료" : "작성 중";
      st.appendChild(badge);
      const time = document.createElement("span");
      time.className = "k";
      time.textContent = a.status === "submitted" ? when(a.submitted_at) : a.saved_at ? when(a.saved_at) + " 저장" : "저장 전";
      const view = document.createElement("button");
      view.type = "button";
      view.className = "btn ghost";
      view.textContent = "보기";
      view.setAttribute("aria-label", a.name + " 지원서 보기");
      view.addEventListener("click", () => openSheet(a.knox_id));
      tr.append(name, knox, st, time, view);
      list.appendChild(tr);
    });
    if (current && $("sheet").open) fillSheet();
  }

  // 답변을 글자로 (객관식 여러 개는 쉼표로 잇기)
  const answerText = (q, v) => {
    if (v == null) return "";
    if (Array.isArray(v)) return v.join(", ");
    return String(v);
  };

  // ── 지원서 보기 창 ──────────────────────────────────────────────
  function openSheet(knox) {
    current = knox;
    fillSheet();
    if (!$("sheet").open) $("sheet").showModal();
  }
  function fillSheet() {
    const a = applicants.find((x) => x.knox_id === current);
    if (!a) { $("sheet").close(); return; }
    $("sheet-name").textContent = a.name + " (" + a.knox_id + ")";
    $("sheet-meta").textContent = (a.status === "submitted" ? "제출 완료 · " + when(a.submitted_at) : "작성 중 · " + (a.saved_at ? when(a.saved_at) + " 마지막 저장" : "아직 저장 안 함"))
      + (a.has_pin ? "" : " · PIN 초기화됨");
    const box = $("sheet-answers");
    box.innerHTML = "";
    questions.forEach((q, i) => {
      const div = document.createElement("div");
      div.className = "answer";
      const b = document.createElement("b");
      b.textContent = "Q" + (i + 1) + ". " + q.title;
      const p = document.createElement("p");
      const text = answerText(q, a.answers ? a.answers[q.id] : null);
      p.textContent = text || "(답변 없음)";
      if (!text) p.className = "none";
      div.append(b, p);
      box.appendChild(div);
    });
    $("sheet-reopen").hidden = a.status !== "submitted";
    $("sheet-pin").disabled = !a.has_pin;
    $("sheet-pin").textContent = a.has_pin ? "PIN 초기화" : "PIN 초기화됨";
  }
  $("sheet-close").addEventListener("click", () => $("sheet").close());
  $("sheet").addEventListener("close", () => { current = null; });
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) $("sheet").close(); });

  $("sheet-pin").addEventListener("click", async (e) => {
    if (!confirm("PIN을 초기화할까요?\n지원자가 다음에 들어올 때 새 PIN을 정하고, 작성한 내용은 그대로 남아요.")) return;
    const out = await call("applicant_reset_pin", { knox_id: current }, e.currentTarget);
    if (out) toast("PIN을 초기화했어요");
  });
  $("sheet-reopen").addEventListener("click", async (e) => {
    if (!confirm("제출을 취소할까요?\n'작성 중'으로 돌아가 지원자가 내용을 고친 뒤 다시 제출할 수 있어요.")) return;
    const out = await call("applicant_reopen", { knox_id: current }, e.currentTarget);
    if (out) toast("작성 중으로 돌렸어요");
  });
  $("sheet-delete").addEventListener("click", async (e) => {
    const a = applicants.find((x) => x.knox_id === current);
    if (!a || !confirm(a.name + " (" + a.knox_id + ") 님의 지원서를 지울까요?\n되돌릴 수 없어요.")) return;
    const out = await call("applicant_delete", { knox_id: current }, e.currentTarget);
    if (out) { $("sheet").close(); toast("지원서를 지웠어요"); }
  });

  // ── 엑셀 다운로드 ───────────────────────────────────────────────
  $("r-excel").addEventListener("click", async (e) => {
    if (!window.XLSX) return toast("엑셀 도구를 불러오지 못했어요. 새로고침해 주세요.");
    const btn = e.currentTarget;
    btn.disabled = true;
    await refreshResponses(); // 받기 직전에 최신으로
    btn.disabled = false;
    const withDraft = $("r-include-draft").checked;
    const rows = applicants
      .filter((a) => withDraft || a.status === "submitted")
      .sort((a, b) => String(a.submitted_at || a.saved_at || a.created_at).localeCompare(String(b.submitted_at || b.saved_at || b.created_at)));
    if (!rows.length) return toast(withDraft ? "받을 지원서가 없어요" : "제출된 지원서가 아직 없어요");

    const head = ["번호", "상태", "이름", "Knox ID", "제출 시각", "마지막 저장"].concat(questions.map((q, i) => "Q" + (i + 1) + ". " + q.title));
    const body = rows.map((a, i) => [
      i + 1,
      a.status === "submitted" ? "제출 완료" : "작성 중",
      a.name,
      a.knox_id,
      stamp(a.submitted_at),
      stamp(a.saved_at),
    ].concat(questions.map((q) => answerText(q, a.answers ? a.answers[q.id] : null))));

    const ws = XLSX.utils.aoa_to_sheet([head].concat(body));
    ws["!cols"] = head.map((h, c) => {
      if (c === 0) return { wch: 6 };
      if (c < 6) return { wch: c === 1 ? 10 : 18 };
      const q = questions[c - 6];
      return { wch: q.type === "long" ? 60 : 24 };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "응답");
    const d = new Date();
    const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    const safe = form.title.replace(/[\\/:*?"<>|]/g, "").trim() || "지원서";
    XLSX.writeFile(wb, safe + "_응답_" + ymd + ".xlsx");
    toast(rows.length + "명의 지원서를 받았어요");
  });
})();
