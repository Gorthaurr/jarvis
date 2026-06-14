/**
 * Диспетчер актуаторов: ActionCommand -> ActionResult (§5, §6).
 *
 * Контракт (§5): на КАЖДЫЙ ActionCommand клиент обязан вернуть ровно один ActionResult,
 * корреляция по commandId (= envelope.id). durationMs обязателен.
 *
 * M0-срез (§17): реально работают app.launch / app.focus / browser.open (через apps.ts).
 * Остальные kind возвращают честный {ok:false, error:{code:"runtime", message:"not implemented (Mx)"}}.
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import * as apps from "./apps.js";
import * as input from "./input.js";
import * as ground from "./ground.js";
import * as browser from "./browser.js";
import * as codeRunner from "./code-runner.js";
import { outcomeToActionResult, runSkill } from "../skill-runner/index.js";
import { createClientActuator } from "../skill-runner/client-actuator.js";
import * as messaging from "./messaging.js";

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
        // Открытие URL = запуск дефолтного браузера на этот URL (apps.launchApp умеет URI).
        const out = await apps.launchApp(cmd.url);
        return okResult(commandId, startedAt, out);
      }

      // ── СТАБЫ (бросают NotImplementedError) ──────────────────
      case "input.type":
        await input.typeText(cmd.text);
        return okResult(commandId, startedAt);
      case "input.key":
        await input.pressKey(cmd.combo);
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
      case "order.place": {
        // Гарды §14 пройдены на сервере; здесь — browser-автоматизация без ввода карты (§0).
        const out = await browser.placeOrder({ vendor: cmd.vendor, items: cmd.items, total: cmd.total });
        return okResult(commandId, startedAt, out);
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
