// Фикстура мессенджера: как настоящие веб-мессенджеры, отправку делает ОБРАБОТЧИК keydown (preventDefault), а не
// submit формы. Режим по умолчанию — однострочный композер: Enter отправляет. ?mode=ctrl — многострочный: Enter —
// перевод строки, Ctrl+Enter — отправка. Кнопка «Отправить» — всегда. Факт message_sent пишет сервер.
(function () {
  var ctrlMode = new URLSearchParams(location.search).get("mode") === "ctrl";
  var composer = document.getElementById("composer");
  var field = document.createElement(ctrlMode ? "textarea" : "input");
  if (!ctrlMode) field.type = "text";
  field.setAttribute("aria-label", "Сообщение");
  field.placeholder = "Сообщение";
  var btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Отправить";
  composer.appendChild(field);
  composer.appendChild(btn);
  document.getElementById("hint").textContent = ctrlMode ? "Ctrl+Enter — отправить, Enter — новая строка" : "Enter — отправить";

  var feed = document.getElementById("feed");
  function show(text) {
    var d = document.createElement("div");
    d.className = "msg me";
    d.textContent = text;
    feed.appendChild(d);
    feed.scrollTop = feed.scrollHeight;
  }

  var sending = false;
  async function send(via) {
    var text = field.value.trim();
    if (!text || sending) return;
    sending = true;
    try {
      var r = await window.bench.api("/api/send", { text: text, via: via });
      if (r && r.ok) {
        show(text);
        field.value = "";
      }
    } finally {
      sending = false;
    }
  }

  field.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    if (ctrlMode) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        send("ctrl_enter");
      }
      return; // Enter без Ctrl — перевод строки (поведение textarea по умолчанию)
    }
    if (!e.shiftKey) {
      e.preventDefault();
      send("enter");
    }
  });
  btn.addEventListener("click", function () { send("button"); });
})();
