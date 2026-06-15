/**
 * Диспетчер актуаторов: ActionCommand -> ActionResult (§5, §6).
 *
 * Контракт (§5): на КАЖДЫЙ ActionCommand клиент обязан вернуть ровно один ActionResult,
 * корреляция по commandId (= envelope.id). durationMs обязателен.
 *
 * Реализованы: app.launch/focus, browser.open/act/read (apps.ts/browser.ts);
 * input.type/key/click, ui.ground/invoke, context.read — через нативный win-сайдкар
 * (sidecar-client, UIAutomation+SendInput); code.run (code-runner); skill.execute
 * (skill-runner); message.send (userbot); order.place (browser). Ввод/UIA требуют
 * запущенного сайдкара — если он не поднят, актуатор честно вернёт runtime-ошибку.
 * НЕ реализованы: screen.capture (M3), demo.record как ActionCommand (M4 — запись
 * навыка инициируется отдельным путём, не через dispatch).
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import * as apps from "./apps.js";
import * as input from "./input.js";
import * as ground from "./ground.js";
import * as browser from "./browser.js";
import * as codeRunner from "./code-runner.js";
import * as fs from "./fs.js";
import * as system from "./system.js";
import * as office from "./office.js";
import { outcomeToActionResult, runSkill } from "../skill-runner/index.js";
import { createClientActuator } from "../skill-runner/client-actuator.js";
import * as messaging from "./messaging.js";
import { jarvisBrowser } from "./jarvis-browser.js";
import { monitors } from "../monitors.js";

const log = createLogger("actuators");

/** Собрать успешный результат с замером длительности. */
function okResult(commandId: string, startedAt: number, data?: unknown): ActionResult {
  return { commandId, ok: true, data, durationMs: Date.now() - startedAt };
}

/** Собрать результат-ошибку (коды строго из протокола). */
function errResult(
  commandId: string,
  startedAt: number,
  code: NonNullable<ActionResult["error"]>["code"],
  message: string,
): ActionResult {
  return { commandId, ok: false, error: { code, message }, durationMs: Date.now() - startedAt };
}

/** Честный «не реализовано на этом milestone» (§17). */
function notImplemented(commandId: string, startedAt: number, milestone: string): ActionResult {
  return errResult(commandId, startedAt, "runtime", `not implemented (${milestone})`);
}

/**
 * Исполнить команду. commandId приходит из envelope.id (см. transport).
 * Любое исключение из актуатора маппится в error.runtime — наружу не утекает.
 */
export async function dispatch(commandId: string, cmd: ActionCommand): Promise<ActionResult> {
  const startedAt = Date.now();
  log.info(`dispatch ${cmd.kind} (commandId=${commandId})`);

  try {
    switch (cmd.kind) {
      // ── РЕАЛЬНО в M0 ──────────────────────────────────────────
      case "app.launch": {
        const out = await apps.launchApp(cmd.app);
        return okResult(commandId, startedAt, out);
      }
      case "app.focus": {
        const out = await apps.focusApp(cmd.app);
        return okResult(commandId, startedAt, out);
      }
      case "browser.open": {
        // Управляемый браузер (CDP) — чтобы дальше работали browser.act/read на этой же
        // странице. Нет Chrome / сбой CDP → мягкий откат на запуск дефолтного браузера.
        try {
          await browser.open(cmd.url);
          return okResult(commandId, startedAt, { url: cmd.url, controlled: true });
        } catch (e) {
          log.warn(`browser.open CDP не удался (${e instanceof Error ? e.message : String(e)}) — откат на launchApp`);
          const out = await apps.launchApp(cmd.url);
          return okResult(commandId, startedAt, { ...out, controlled: false });
        }
      }

      // ── СТАБЫ (бросают NotImplementedError) ──────────────────
      case "input.type":
        await input.typeText(cmd.text);
        return okResult(commandId, startedAt);
      case "input.key":
        await input.pressKey(cmd.combo, cmd.mode, cmd.scancode);
        return okResult(commandId, startedAt);
      case "input.click":
        await input.click(cmd.target);
        return okResult(commandId, startedAt);
      case "ui.invoke":
        await ground.invoke(cmd.target, cmd.pattern, cmd.value);
        return okResult(commandId, startedAt);
      case "ui.ground": {
        const g = await ground.ground(cmd.query);
        return okResult(commandId, startedAt, g);
      }
      case "browser.act":
        await browser.act(cmd.intent, cmd.params);
        return okResult(commandId, startedAt);
      case "browser.read": {
        const r = await browser.read(cmd.selectorIntent);
        return okResult(commandId, startedAt, r);
      }
      case "code.run": {
        const r = await codeRunner.run(cmd.lang, cmd.code);
        return okResult(commandId, startedAt, r);
      }

      // ── skill-runner (tier-0.5, §8): локальное исполнение шагов без LLM ──
      case "skill.execute": {
        const cancel = { cancelled: false }; // TODO(M8): связать с отменой задачи (§20)
        const outcome = await runSkill({
          skillId: cmd.skillId,
          version: cmd.version,
          steps: cmd.steps,
          params: cmd.params,
          cancel,
          actuator: createClientActuator(),
          // escalate на needs_llm/exhausted — клиент↔сервер round-trip (TODO M4+): пока no-op.
        });
        return outcomeToActionResult(commandId, outcome, Date.now() - startedAt);
      }
      case "screen.capture":
        return notImplemented(commandId, startedAt, "M3");
      case "context.read": {
        // Дейксис (§19): selection/active_window через сайдкар (TextPattern); screen — vision (позже).
        const text = await ground.readContext(cmd.scope);
        return okResult(commandId, startedAt, { scope: cmd.scope, text });
      }
      case "demo.record":
        return notImplemented(commandId, startedAt, "M4");
      case "message.send": {
        // Гарды §14 (confirm/cadence/idempotency) уже пройдены на сервере; здесь — доставка userbot'ом (§12).
        const out = await messaging.sendMessage(cmd.channel, cmd.to, cmd.body);
        return okResult(commandId, startedAt, out);
      }
      case "telegram.send": {
        // НЕВИДИМАЯ отправка в Telegram через браузер Джарвиса (off-screen Chrome + CDP, §6).
        // НЕ MTProto/userbot (см. message.send) — реальный webK в скрытом окне.
        const out = await jarvisBrowser().telegramSend(cmd.to, cmd.text);
        return okResult(commandId, startedAt, out);
      }
      case "telegram.read": {
        const out = await jarvisBrowser().telegramRead(cmd.to, cmd.count);
        return okResult(commandId, startedAt, out);
      }
      // «Браузер Джарвиса» (§6): общие невидимые примитивы над его залогиненным профилем.
      case "jbrowser.open": {
        const out = await jarvisBrowser().open(cmd.url);
        return okResult(commandId, startedAt, out);
      }
      case "jbrowser.read": {
        const out = await jarvisBrowser().read();
        return okResult(commandId, startedAt, out);
      }
      case "jbrowser.act": {
        const out = await jarvisBrowser().act(cmd.intent, cmd.params);
        return okResult(commandId, startedAt, out);
      }
      case "order.place": {
        // Гарды §14 пройдены на сервере; здесь — browser-автоматизация без ввода карты (§0).
        const out = await browser.placeOrder({ vendor: cmd.vendor, items: cmd.items, total: cmd.total });
        return okResult(commandId, startedAt, out);
      }

      // ── Файловая система (§6): прямое управление файлами ──────
      case "fs.read":
        return okResult(commandId, startedAt, await fs.readFile(cmd.path, cmd.maxBytes));
      case "fs.write":
        return okResult(commandId, startedAt, await fs.writeFile(cmd.path, cmd.content, cmd.createDirs));
      case "fs.append":
        return okResult(commandId, startedAt, await fs.appendFile(cmd.path, cmd.content));
      case "fs.list":
        return okResult(commandId, startedAt, await fs.listDir(cmd.path, cmd.recursive));
      case "fs.delete":
        // Необратимо: confirm уже взят на сервере (§4); здесь — исполнение.
        return okResult(commandId, startedAt, await fs.deleteEntry(cmd.path, cmd.recursive));
      case "fs.move":
        return okResult(commandId, startedAt, await fs.moveEntry(cmd.from, cmd.to));
      case "fs.mkdir":
        return okResult(commandId, startedAt, await fs.makeDir(cmd.path));
      case "fs.search":
        return okResult(commandId, startedAt, await fs.search(cmd.root, cmd.query, cmd.inContent, cmd.maxResults));

      // ── Системное управление (§6): питание/блокировка/медиа/громкость/буфер ──
      case "system.lock":
      case "system.power":
      case "system.media":
      case "system.volume":
      case "system.clipboard":
        return okResult(commandId, startedAt, await system.runSystem(cmd));

      // ── Office как живые приложения (§6): Word/Excel через COM ──
      case "office.excel":
        return okResult(commandId, startedAt, await office.runExcel(cmd));
      case "office.word":
        return okResult(commandId, startedAt, await office.runWord(cmd));

      // ── Мультимонитор (§6): куда уводить видимую активность Джарвиса ──
      case "monitor.set": {
        monitors.setTarget(cmd.target);
        return okResult(commandId, startedAt, { target: cmd.target, summary: monitors.summary() });
      }

      default: {
        // Исчерпывающая проверка union: при добавлении нового kind тут будет ошибка типа.
        const _exhaustive: never = cmd;
        return errResult(commandId, startedAt, "runtime", `unknown kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error(`actuator ${cmd.kind} упал: ${message}`);
    // NotImplementedError из стабов — это тоже runtime-ошибка наружу (честно).
    return errResult(commandId, startedAt, "runtime", message);
  }
}
