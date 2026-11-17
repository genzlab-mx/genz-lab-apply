// 지원자 화면과 관리 화면이 함께 쓰는 연결·도우미 함수
(function () {
  const cfg = window.APPLY_CONFIG;
  const params = new URLSearchParams(location.search);
  const code = params.get("f") || cfg.formCode;
  // ?demo=1 : 서버 없이 이 브라우저 안에서만 동작하는 미리보기 (js/demo.js)
  const demo = params.get("demo") === "1";

  const db = !demo && window.supabase
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    : null;

  const friendly = (msg) => {
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "인터넷 연결을 확인해 주세요.";
    if (/Could not find the function|schema cache/i.test(msg)) return "서버 설정이 아직 안 됐어요. (supabase/apply.sql 실행 필요)";
    return msg;
  };

  // 지원자용 DB 함수 호출. 함수는 {ok:false, error, message} 로 실패를 알려 주기도 합니다.
  async function rpc(name, args) {
    if (demo) return window.APDemo.rpc(name, args);
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error(friendly(error.message));
    return data;
  }

  // 관리자 Edge Function(apply-admin) 호출
  async function admin(password, action, extra) {
    if (demo) return window.APDemo.admin(action, extra || {});
    let res;
    try {
      res = await fetch(cfg.supabaseUrl + "/functions/v1/apply-admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: cfg.supabaseKey },
        body: JSON.stringify(Object.assign({ password, code, action }, extra)),
      });
    } catch (e) {
      throw new Error(friendly(String(e && e.message)));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 404 && !data.error) throw new Error("관리자 함수(apply-admin)가 아직 배포되지 않았어요.");
      throw new Error(data.error || data.message || "요청에 실패했어요 (" + res.status + ")");
    }
    return data;
  }

  let toastTimer;
  function toast(message) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
  }

  const pad = (n) => String(n).padStart(2, "0");
  // "11/17 오후 2:03"
  function when(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const h = d.getHours();
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + (h < 12 ? "오전 " : "오후 ") + ((h % 12) || 12) + ":" + pad(d.getMinutes());
  }
  // "2026-11-17 14:03" (엑셀용)
  function stamp(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  // 단답 200자, 장문 3000자가 기본 (서버 ap_submit 과 같아야 합니다)
  const limitOf = (q) => q.max_length || (q.type === "short" ? 200 : 3000);

  // 지원자가 쓰는 Knox ID 정리 (서버 ap_knox 와 같은 규칙)
  const knoxOf = (s) => String(s || "").trim().toLowerCase().split("@")[0];

  const TYPE_LABEL = { short: "단답형", long: "장문형", single: "객관식 · 하나", multi: "객관식 · 여러 개" };

  window.AP = { cfg, code, demo, rpc, admin, toast, when, stamp, limitOf, knoxOf, TYPE_LABEL };
})();
