/**
 * Jarvis Web Hands — service worker расширения.
 *
 * Связь с сервером Джарвиса по WS (ws://127.0.0.1:8787/ext). Сервер шлёт интенты
 * ({id, type, ...}); расширение исполняет их в ТВОЁМ Chrome на ТВОИХ логинах через
 * ФОНОВУЮ вкладку (active:false) и отвечает {id, ok, data|error}. Никаких новых входов,
 * никакого debug-порта, вкладка в фоне → почти невидимо.
 */

const WS_URL = "ws://127.0.0.1:8787/ext";
let ws = null;
let reconnectTimer = null;

function connect() {
  // Закрываем прежний сокет и снимаем таймер — иначе alarm-keepalive и scheduleReconnect
  // могут поднять ДВА параллельных WebSocket, старый повиснет (гонка переподключения).
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.onclose = null;
      ws.close();
    } catch {
      /* уже мёртв */
    }
    ws = null;
  }
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    console.log("[jarvis] подключился к серверу");
    send({ type: "hello", agent: "jarvis-web-hands", version: "0.1.0" });
  };
  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || !msg.id) return;
    try {
      const data = await handle(msg);
      send({ id: msg.id, ok: true, data });
    } catch (e) {
      send({ id: msg.id, ok: false, error: String((e && e.message) || e) });
    }
  };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

/** Роутинг интентов сервера. */
async function handle(msg) {
  switch (msg.type) {
    case "ping":
      return "pong";
    case "reload":
      // DEV: перечитать РАСПАКОВАННОЕ расширение с диска (подхватывает правки background.js
      // без ручного ↻ в chrome://extensions). Отвечаем СЕЙЧАС, reload — через микрозадержку,
      // иначе SW умрёт раньше, чем уйдёт ответ. После reload SW сам переподключится по WS.
      setTimeout(() => { try { chrome.runtime.reload(); } catch (e) { /* ignore */ } }, 150);
      return "reloading";
    case "telegram.send":
      return telegramSend(String(msg.to || ""), String(msg.text || ""));
    default:
      throw new Error("неизвестный интент: " + msg.type);
  }
}

/** Дождаться полной загрузки вкладки. */
function waitTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (tab && tab.status === "complete") return resolve();
        if (Date.now() - t0 > timeoutMs) return resolve(); // не виснем — отдаём что есть
        setTimeout(tick, 250);
      });
    };
    tick();
  });
}

/**
 * Отправить сообщение в Telegram через web.telegram.org/k/ в ФОНОВОЙ вкладке.
 * Открываем вкладку (твоя залогиненная сессия) → ждём → инжектим страничную функцию →
 * закрываем вкладку. Возвращаем подробный результат (для отладки селекторов).
 */
async function telegramSend(to, text) {
  if (!to || !text) throw new Error("нужны to и text");
  // ОТДЕЛЬНОЕ ОКНО БЕЗ ФОКУСА (§6 «невидимые руки»): focused:false — не крадём фокус. Для
  // Chrome окно «видимое» (не свёрнуто, не перекрыто) → requestAnimationFrame работает → webK
  // рендерит UI. В фоновой ВКЛАДКЕ rAF на паузе и UI не рисуется — поэтому именно окно.
  // ВНИМАНИЕ: Chrome запрещает окна за экраном (>50% должно быть в видимой области) — поэтому
  // позиция валидная, на экране. Куда именно прятать (второй монитор / нативный сдвиг сайдкаром)
  // — решается отдельно; сейчас проверяем сам факт отправки в неподфокусенном окне.
  const OFFSCREEN = { left: 80, top: 80, width: 520, height: 800 };
  const win = await chrome.windows.create({
    url: "https://web.telegram.org/k/",
    focused: false,
    type: "normal",
    ...OFFSCREEN,
  });
  const tab = win && win.tabs && win.tabs[0];
  if (!tab) {
    try { if (win) await chrome.windows.remove(win.id); } catch { /* ignore */ }
    throw new Error("не удалось открыть окно");
  }
  try {
    // Подстраховка: повторно загоняем окно за экран и снимаем фокус (если Chrome при создании
    // поставил его иначе — клампинг позиции/фокуса зависит от платформы).
    try { await chrome.windows.update(win.id, { ...OFFSCREEN, focused: false, state: "normal" }); } catch { /* ignore */ }
    await waitTabComplete(tab.id);
    await new Promise((r) => setTimeout(r, 3500)); // дать SPA подняться (webK холодный старт ~3-5с)
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: tgSendInPage,
      args: [to, text],
    });
    const res = (results && results[0] && results[0].result) || { ok: false, step: "no-result", error: "executeScript без результата" };
    if (!res.ok) {
      // ВАЖНО для отладки: пробрасываем step + dom-дамп НАВЕРХ (в текст ошибки), иначе цикл
      // правки селекторов слеп — сервер возвращает только e.message, а res.dom терялся.
      const dom = res.dom ? " | DOM=" + JSON.stringify(res.dom) : "";
      throw new Error("telegram: " + res.step + ": " + res.error + dom);
    }
    return res;
  } finally {
    try {
      await chrome.windows.remove(win.id);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Исполняется ВНУТРИ страницы web.telegram.org/k/ (self-contained — без внешних ссылок).
 * Best-effort v1: ищет контакт, открывает чат, печатает, отправляет. Возвращает диагностику.
 */
function tgSendInPage(to, text) {
  return new Promise((resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // ВИДИМОСТЬ: offsetParent === null для position:fixed/sticky (шапка поиска webK как раз
    // в фикс/трансформ-контейнере) → старая проверка ложно скрывала валидный input. Считаем
    // элемент видимым по геометрии + вычисленным стилям.
    const visible = (el) => {
      if (!el) return false;
      const rects = el.getClientRects();
      if (!rects || rects.length === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
      const b = el.getBoundingClientRect();
      return b.width > 1 && b.height > 1;
    };
    const lc = (s) => String(s || "").toLowerCase();
    const q = (sels) => { for (const s of sels) { const el = document.querySelector(s); if (el && visible(el)) return el; } return null; };

    // Поле поиска: сперва известные классы webK (input-search-input), затем эвристика по
    // placeholder/aria, затем первый видимый текстовый input в левой колонке.
    const findSearch = () => {
      const known = q(['.input-search input', 'input.input-search-input', '#column-left input.input-field-input', '.sidebar-header input']);
      if (known) return known;
      const inputs = [...document.querySelectorAll('input')].filter(visible);
      const byHint = inputs.find((el) => {
        const h = lc(el.placeholder) + " " + lc(el.getAttribute("aria-label"));
        return h.includes("search") || h.includes("поиск");
      });
      if (byHint) return byHint;
      const left = document.querySelector('#column-left, .sidebar-left, .LeftColumn, [class*="left" i]') || document;
      return [...left.querySelectorAll('input[type="text"], input:not([type]), input.input-field-input')].find(visible) || null;
    };
    // Поле сообщения: известный класс webK input-message-input, затем видимый contenteditable.
    const findMsgInput = () => {
      const known = q(['.input-message-input[contenteditable="true"]', 'div.input-message-input']);
      if (known) return known;
      const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
      return eds.find((el) => {
        const h = lc(el.getAttribute("aria-label")) + " " + lc(el.dataset && el.dataset.placeholder) + " " + lc(el.className);
        return h.includes("message") || h.includes("сообщен") || h.includes("input-message");
      }) || eds[eds.length - 1] || null;
    };
    const waitForFn = async (fn, timeout = 15000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { const el = fn(); if (el) return el; await sleep(200); }
      return null;
    };
    // Диагностика DOM на провале — чтобы поправить селекторы без лишних кругов reload.
    const dumpDom = () => {
      const ins = [...document.querySelectorAll('input')].slice(0, 12).map((e) =>
        `input#${e.id}.${e.className}|ph="${e.placeholder}"|aria="${e.getAttribute("aria-label")}"|type=${e.type}|vis=${visible(e)}`);
      const eds = [...document.querySelectorAll('[contenteditable="true"]')].slice(0, 8).map((e) =>
        `ce#${e.id}.${e.className}|ph="${e.dataset && e.dataset.placeholder}"|aria="${e.getAttribute("aria-label")}"|vis=${visible(e)}`);
      const btns = [...document.querySelectorAll('button')].slice(0, 14).map((e) =>
        `btn.${e.className}|aria="${e.getAttribute("aria-label")}"|vis=${visible(e)}`);
      const authEl = document.querySelector('#auth-pages, .auth-pages, [class*="signIn" i], [class*="sign-in" i], [class*="authCode" i]');
      const hasAuthClass = document.body ? document.body.classList.contains("has-auth-pages") : false;
      const bodyText = (document.body ? document.body.innerText || "" : "").replace(/\s+/g, " ").trim().slice(0, 400);
      return {
        url: location.href,
        title: document.title,
        bodyClass: document.body ? document.body.className : "",
        hasAuthClass,                      // body.has-auth-pages → НЕ залогинен / экран входа
        visibilityState: document.visibilityState, // hidden → фоновая вкладка тормозит рендер
        hasChatlist: Boolean(document.querySelector('.chatlist, ul.chatlist, #folders-container')),
        looksLoggedIn: !authEl && !hasAuthClass,
        inputCount: document.querySelectorAll('input').length,
        ceCount: document.querySelectorAll('[contenteditable="true"]').length,
        bodyText,
        inputs: ins, editables: eds, buttons: btns,
      };
    };
    const setInput = (el, val) => {
      el.focus();
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, val);
      else el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
    };
    // Полная цепочка указателя — webK-элементы списка реагируют на mousedown/up, не только click.
    const realClick = (el) => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
    };

    (async () => {
      try {
        // 0) Не залогинен → дальше бессмысленно, сразу диагностируем.
        await sleep(300);
        const dom0 = dumpDom();
        if (!dom0.looksLoggedIn && !dom0.hasChatlist) {
          // дать ещё шанс догрузиться, потом проверить повторно
          await sleep(2500);
          const d = dumpDom();
          if (!d.looksLoggedIn) return resolve({ ok: false, step: "not-logged-in", error: "похоже, не залогинен в web.telegram.org/k/", dom: d });
        }

        // 1) Поле поиска.
        const search = await waitForFn(findSearch);
        if (!search) return resolve({ ok: false, step: "search-input", error: "не нашёл поле поиска", dom: dumpDom() });
        realClick(search);
        search.focus();
        setInput(search, to);
        await sleep(2200);

        // 2) Результат-чат СТРОГО по совпадению текста — НИКАКОГО слепого items[0]
        //    (иначе при неотфильтрованном списке уйдём в случайный чужой чат). Saved Messages
        //    в RU-интерфейсе = «Избранное», в EN = «Saved Messages» — матчим оба.
        const wantSaved = /избранн|saved/i.test(to);
        const matchesTarget = (el) => {
          const t = lc(el.textContent);
          if (lc(to) && t.includes(lc(to))) return true;
          if (wantSaved && (t.includes("saved messages") || t.includes("избранное"))) return true;
          return false;
        };
        const findResult = () => {
          const items = [...document.querySelectorAll(
            'a.chatlist-chat, li.chatlist-chat, .chatlist-chat, ul.chatlist > a, ul.chatlist > li, .search-group a.row, a.row.chatlist-chat, [class*="chatlist-chat" i]'
          )].filter(visible);
          return items.find(matchesTarget) || null;
        };
        const result = await waitForFn(findResult, 10000);
        if (!result) return resolve({ ok: false, step: "search-result", error: "не нашёл контакт «" + to + "» (совпадений нет — не шлём в случайный чат)", dom: dumpDom() });
        realClick(result);
        await sleep(2000);

        // 3) Поле ввода сообщения.
        const input = await waitForFn(findMsgInput);
        if (!input) return resolve({ ok: false, step: "message-input", error: "не нашёл поле сообщения", dom: dumpDom() });
        input.focus();
        // contenteditable: вставляем текст и шлём input-событие.
        document.execCommand && document.execCommand("insertText", false, text);
        if (!(input.textContent || "").trim()) {
          input.textContent = text;
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        }
        await sleep(700);

        // 4) Отправка: кнопка send или Enter.
        const sendBtn = q(['.btn-send', '.btn-send-container button', 'button.send', '.chat-input .btn-send']);
        if (sendBtn) {
          realClick(sendBtn);
        } else {
          const ev = (type) => input.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
          ev("keydown");
          ev("keypress");
          ev("keyup");
        }
        // 5) ПОДТВЕРДИТЬ: webK очищает поле ввода после успешной отправки. Если поле всё ещё с
        //    текстом — сообщение НЕ ушло (не выдаём ложный успех).
        let sent = false;
        for (let i = 0; i < 15; i += 1) {
          await sleep(200);
          if ((input.textContent || "").trim().length === 0) { sent = true; break; }
        }
        if (!sent) return resolve({ ok: false, step: "send-verify", error: "поле не очистилось — отправка не подтверждена", dom: dumpDom() });
        resolve({ ok: true, to, sent: text.slice(0, 40) });
      } catch (e) {
        resolve({ ok: false, step: "exception", error: String((e && e.message) || e) });
      }
    })();
  });
}

// MV3 service worker засыпает — поэтому: коннектим на старте/установке И держим живым
// будильником (chrome.alarms будит SW каждые ~24с → переподключаем, если связь упала).
// Открытый WS сам продлевает жизнь SW (Chrome 116+), будильник — страховка.
connect();
chrome.runtime.onStartup?.addListener(connect);
chrome.runtime.onInstalled?.addListener(connect);
try {
  chrome.alarms.create("jarvis-keepalive", { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener(() => {
    // Через единый дебаунс-путь (scheduleReconnect), не дёргаем connect() напрямую —
    // иначе гонка с onclose→scheduleReconnect создаёт два сокета.
    if (!ws || ws.readyState === 2 || ws.readyState === 3) scheduleReconnect();
  });
} catch (e) {
  console.log("[jarvis] alarms недоступны:", e);
}
