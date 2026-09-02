// Драйвер Джарвиса текстом (dev.text) — гоняю команды как пользователь, смотрю результат сам.
// Запуск: node _jarvis_cmd.mjs "команда1" "да, отправляй" ...  (шлёт по очереди с паузой, отвечает на ping)
// Порт настраивается (env JARVIS_WS_URL): изолированный тестовый инстанс поднимается на другом порту,
// а хардкод 8787 молча уводил проверки в БОЕВОЙ сервер — прогон «нового кода» шёл мимо него.
const WS_URL = process.env.JARVIS_WS_URL || "ws://127.0.0.1:8787/ws";
const msgs = process.argv.slice(2).filter((a) => !/^\d+$/.test(a));
const STEP_MS = 11000; // пауза между репликами (даём агенту ответить/спросить «отправляю?»)
const TIMEOUT_MS = 130000;
const ws = new WebSocket(WS_URL);
const send = (type, payload) =>
  ws.send(JSON.stringify({ id: globalThis.crypto.randomUUID(), ts: Date.now(), type, payload }));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let idx = 0;
const sendNext = () => {
  if (idx >= msgs.length) return;
  const t = msgs[idx++];
  log("→ dev.text:", t);
  send("dev.text", { text: t });
  if (idx < msgs.length) setTimeout(sendNext, STEP_MS);
};

ws.onopen = () => {
  log("WS open → hello");
  // Продуктовый режим (2026-09-02): токен тестового пользователя из JARVIS_CLIENT_TOKEN (то же имя, что у
  // Electron-клиента); дефолт "dev" — поведение драйвера при мастер-флаге 0 не меняется.
  send("client.hello", { token: process.env.JARVIS_CLIENT_TOKEN || "dev", clientVersion: "cmd-test", protocolVersion: 1 });
};
ws.onerror = (e) => log("WS error", e.message || e);
ws.onclose = () => log("WS closed");
ws.onmessage = (ev) => {
  let env;
  try { env = JSON.parse(ev.data); } catch { return; }
  const p = env.payload || {};
  switch (env.type) {
    case "server.hello":
      log("server.hello session=", p.sessionId, "resumed=", p.resumed);
      setTimeout(sendNext, 300);
      break;
    case "ping":
      send("pong", {}); // КЛЮЧЕВОЕ: иначе heartbeat закроет сессию
      break;
    case "chat":
      log(`CHAT[${p.role}]:`, p.text);
      break;
    case "transcript":
      if (p.final) log("transcript:", p.text);
      break;
    case "task.status":
      log(`task[${p.state}]`, p.title || "", `${p.stepsDone ?? ""}/${p.stepsTotal ?? ""}`);
      break;
    case "ui.display":
      log("CARD:", p.title || "", String(p.markdown || "").slice(0, 200));
      break;
    case "user.confirm.request":
      log("CONFIRM-REQ:", p.kind, "—", p.summary, "→ AUTO-APPROVE");
      send("user.confirm.result", { requestId: p.requestId, approved: true });
      break;
    case "action.command":
      log("ACTION→client:", p.kind, JSON.stringify(p).slice(0, 160));
      // 🔴 ЧЕСТНОСТЬ ДРАЙВЕРА (2026-09-01). Раньше здесь стояло `ok: true` «чтобы петля не висла» —
      // и это ЛОЖНЫЙ УСПЕХ актуатора, ровно то, что закон проекта запрещает инструментам. Цена
      // оказалась высокой: проверка новых актуаторов (перенос окна на монитор, пер-процессный звук)
      // прошла «успешно», хотя окно не двигалось и звук не читался — модель получала выдуманный ok
      // и докладывала «готово, проверено». Правило проекта «проверяй живым прогоном текст-драйвером»
      // превращалось в ловушку: клиентская половина не проверяется им ВООБЩЕ.
      // Теперь отказ ЧЕСТНЫЙ: петля не виснет (ответ приходит сразу), но выдать это за успех нельзя.
      // Реально исполнить действие можно только настоящим клиентом: POST /dev/action при
      // JARVIS_DEV_HTTP=1 шлёт команду в подключённый Electron и возвращает НАСТОЯЩИЙ результат.
      send("action.result", {
        commandId: env.id,
        ok: false,
        error: {
          code: "runtime",
          message:
            "текст-драйвер не исполняет действия на ПК (это не настоящий клиент). " +
            "Результат неизвестен — не считай это выполненным. Проверять актуаторы: POST /dev/action " +
            "при JARVIS_DEV_HTTP=1 (уходит в реальный Electron-клиент) или живьём голосом/через окно клиента.",
        },
        durationMs: 1,
      });
      break;
    case "speak.chunk":
    case "ping":
    case "transcript":
      break;
    default:
      log("msg:", env.type);
  }
};
setTimeout(() => { log("--- timeout, закрываю ---"); try { ws.close(); } catch {} process.exit(0); }, TIMEOUT_MS);
