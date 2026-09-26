// Стенд: общий скрипт страниц фикстур. run (метка прогона сценария) берётся из ?run= и живёт в sessionStorage +
// cookie хоста (формы с POST и редиректы несут его сами). bench.api — действие сайта (факт журналирует СЕРВЕР),
// bench.trace — что страница видела сама (клик/клавиша/page_view, с isTrusted).
(function () {
  var qs = new URLSearchParams(location.search);
  var run = qs.get("run");
  if (run) {
    try { sessionStorage.setItem("bench_run", run); } catch (e) { /* нет storage */ }
    document.cookie = "bench_run=" + encodeURIComponent(run) + "; path=/; SameSite=Lax; Secure";
  } else {
    var fromCookie = /(?:^|;\s*)bench_run=([^;]+)/.exec(document.cookie);
    try { run = sessionStorage.getItem("bench_run"); } catch (e) { run = null; }
    run = run || (fromCookie ? decodeURIComponent(fromCookie[1]) : "");
  }

  function trace(type, data) {
    try {
      fetch("/__bench/trace", {
        method: "POST",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: type, data: data || {}, run: run, path: location.pathname }),
      }).catch(function () {});
    } catch (e) { /* страница уходит */ }
  }

  async function api(path, body) {
    var r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.assign({}, body || {}, { run: run })),
    });
    return r.json();
  }

  function label(el) {
    return String((el && (el.getAttribute("aria-label") || el.innerText || el.value)) || "").trim().slice(0, 60);
  }
  document.addEventListener("click", function (e) {
    trace("click", { tag: e.target.tagName, text: label(e.target), isTrusted: e.isTrusted });
  }, true);
  document.addEventListener("keydown", function (e) {
    if (e.key.length === 1 && !e.ctrlKey) return; // печать посимвольно не шумим — только служебные клавиши
    trace("keydown", { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, isTrusted: e.isTrusted });
  }, true);
  window.addEventListener("load", function () { trace("page_view", { title: document.title }); });
  // Формы с POST несут run скрытым полем (cookie — страховка).
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (f && f.method && f.method.toLowerCase() === "post" && !f.querySelector("input[name=run]")) {
      var i = document.createElement("input");
      i.type = "hidden"; i.name = "run"; i.value = run;
      f.appendChild(i);
    }
  }, true);
  window.bench = { run: run, api: api, trace: trace };
})();
