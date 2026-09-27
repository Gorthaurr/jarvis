/**
 * Локальный мост актуаторов (jarvis SDK, среда исполнения «1 раунд = вся задача»).
 *
 * ЗАЧЕМ. Многошаговая GUI-задача шла как N LLM-раундов (скриншот → клик → скриншот). Мост даёт code_run-скрипту
 * (питон, ОТДЕЛЬНЫЙ процесс) прямой доступ к тем же актуаторам через loopback-HTTP: ОДИН скрипт с `jarvis.*`
 * (focus/press/click/wait_for/find/ocr…) делает ВСЮ процедуру за один раунд.
 * БЕЗОПАСНОСТЬ. Мост НЕ расширяет полномочия: code_run уже исполняет произвольный код; вызов идёт через тот же
 * `dispatch` с его гардами (USER_BUSY, fs self-guard, честный провал) + рубеж инжекции. Bind ТОЛЬКО на 127.0.0.1 +
 * токен per-boot в заголовке (лишь в env спавнутого раннера) → чужой локальный процесс не дёрнет. Тело ≤ BODY_CAP.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { runWithoutApproval } from "./approval-scope.js";
import { foregroundProcess, guardedDispatch } from "./commit-guard.js";

const log = createLogger("actuator:act-bridge");

/** Потолок тела запроса (актуатор-команды маленькие; большой ввод — через fs). */
const BODY_CAP = 512 * 1024;

/**
 * ALLOWLIST разрешённых на мосту ActionCommand.kind (ревью jarvis SDK, HIGH security-guard-bypass). Мост НЕ должен
 * быть вторым, НЕГЕЙТЁННЫМ входом для привилегированных каналов: серверные §14-гарды (confirm-once/cadence/
 * idempotency/card-red-line) и креды (Telegram StringSession, VK-токен, залогиненный jarvis-browser) живут В СЕРВЕРНОМ
 * пути ДО эмита команды, клиентские хендлеры исполняют без них. code_run-скрипт (в т.ч. под prompt-injection) может
 * сырым POST дёрнуть мост — поэтому здесь ТОЛЬКО механический GUI + восприятие; отправка/заказы/креды/необратимое
 * (message.send, telegram.*, order.place, jbrowser.*, code.run, fs.*, office.*, system.*) — серверным tool-путём.
 */
export const BRIDGE_ALLOWED_KINDS: ReadonlySet<string> = new Set<string>([
  // запуск / окна (механический GUI)
  "app.launch",
  "app.focus",
  "app.close",
  "window.list",
  "window.focus",
  // ввод
  "input.type",
  "input.key",
  "input.click",
  "input.mouse",
  // W4 «Руки»: один примитив «найди-сделай-сверь» — тот же механический GUI, что input.*/ui.invoke
  "gui.act",
  // UIA-действие / грундинг
  "ui.invoke",
  "ui.ground",
  "ui.snapshot",
  // восприятие (read-only)
  "screen.capture",
  "screen.ocr",
  "screen.probe",
  "context.read",
  "wait.for",
]);

/** Исполнитель команды — тот же dispatch актуаторов (внедряется, чтобы мост тестировался без Electron). */
export type DispatchFn = (commandId: string, cmd: ActionCommand) => Promise<ActionResult>;

export interface ActBridge {
  /** Порт loopback-сервера. */
  port: number;
  /** Токен доступа (заголовок X-Jarvis-Token) — отдаётся ТОЛЬКО в env раннера. */
  token: string;
  /** Остановить мост (graceful shutdown). */
  stop(): Promise<void>;
}

/**
 * Поднять loopback-мост актуаторов. dispatch внедряется (актуаторный dispatch клиента). Возвращает
 * {port, token, stop}. Жизненный цикл — на вызывающем (стартуем один раз на boot, гасим на выходе).
 * W2 (пакет 0): гард §14 моста (commit-guard) и область БЕЗ одобрения — внутри моста, а не у вызывающего: команда
 * моста исполняется в `runWithoutApproval("bridge")`, даже если python запущен изнутри одобренной серверной команды.
 * `fg` — передний план для гарда (тесты подменяют).
 */
export function startActBridge(rawDispatch: DispatchFn, fg: () => Promise<string | null> = foregroundProcess): Promise<ActBridge> {
  const guarded = guardedDispatch(rawDispatch, fg);
  const dispatch: DispatchFn = (commandId, cmd) => runWithoutApproval("bridge", () => guarded(commandId, cmd), commandId);
  const token = randomUUID();
  let counter = 0;

  const server: Server = createServer((req, res) => {
    // Только POST /act; всё прочее — 404 (мост узкий, не общий API).
    if (req.method !== "POST" || req.url !== "/act") {
      res.writeHead(404).end();
      return;
    }
    // Токен-гейт (loopback + секрет): чужой локальный процесс без токена не дёрнет актуаторы.
    if (req.headers["x-jarvis-token"] !== token) {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: { code: "denied", message: "bad token" } }));
      return;
    }
    let body = "";
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      if (tooBig) return;
      body += chunk.toString("utf8");
      if (body.length > BODY_CAP) {
        tooBig = true;
        res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: { code: "runtime", message: "body too large" } }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return;
      let cmd: ActionCommand;
      try {
        const parsed = JSON.parse(body || "{}") as { kind?: string };
        if (!parsed || typeof parsed.kind !== "string") throw new Error("missing kind");
        cmd = parsed as unknown as ActionCommand;
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: { code: "runtime", message: `bad request: ${e instanceof Error ? e.message : String(e)}` } }));
        return;
      }
      // Гейт возможностей моста: только механический GUI/восприятие. Привилегированные каналы (отправка/
      // заказы/креды/необратимое) — 403, обязаны идти серверным путём с §14-гардами (см. BRIDGE_ALLOWED_KINDS).
      if (!BRIDGE_ALLOWED_KINDS.has(cmd.kind)) {
        log.warn("act-bridge: kind вне allowlist отклонён", { kind: cmd.kind });
        res
          .writeHead(403, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: false, error: { code: "denied", message: `kind '${cmd.kind}' не разрешён на мосту SDK (только механический GUI/восприятие; отправка/заказы/креды — через серверный tool-путь с §14-гейтом)` } }));
        return;
      }
      const commandId = `bridge-${(counter += 1).toString(36)}`;
      // dispatch НЕ бросает наружу (любое исключение → error.runtime внутри), но защищаемся на всякий.
      void dispatch(commandId, cmd)
        .then((result) => {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        })
        .catch((e) => {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ commandId, ok: false, error: { code: "runtime", message: e instanceof Error ? e.message : String(e) }, durationMs: 0 }),
          );
        });
    });
    req.on("error", () => {
      try {
        res.writeHead(400).end();
      } catch {
        /* соединение уже закрыто */
      }
    });
  });

  // Незаслушанный 'error' на сервере (порт занят/EACCES) уронил бы main — деградируем логом.
  server.on("error", (e) => log.warn("act-bridge сервер: ошибка", { error: e instanceof Error ? e.message : String(e) }));

  return new Promise<ActBridge>((resolve, reject) => {
    // port 0 → ОС выдаёт свободный; bind СТРОГО на loopback (не наружу).
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("act-bridge: не удалось получить порт"));
        return;
      }
      log.info("act-bridge поднят (loopback)", { port: addr.port });
      resolve({
        port: addr.port,
        token,
        stop: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
