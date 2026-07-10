/**
 * Клиентский SkillActuator (§8): мапит шаги навыка на реальные актуаторы.
 *
 * executeStep — ground+действие через сайдкар/apps; checkExpect — проверка
 * постусловия через UIA-грундинг (элемент с role/name существует). Без сайдкара
 * UIA-шаги бросают/возвращают false — раннер корректно деградирует.
 */
import type { SkillStep } from "@jarvis/protocol";
import type { UiPattern } from "@jarvis/protocol";
import { createLogger, sleep } from "@jarvis/shared";
import * as apps from "../actuators/apps.js";
import * as ground from "../actuators/ground.js";
import * as input from "../actuators/input.js";
import type { SkillActuator } from "./index.js";

const log = createLogger("skill-actuator");

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined ? "" : String(v);
}

/** Действия навыка, ФИЗИЧЕСКИ инжектящие ввод в сессию юзера (мышь/клава через SendInput). */
const PHYSICAL_STEP_ACTIONS = new Set<SkillStep["action"]>(["input.type", "input.key", "input.click"]);

/**
 * §H5: USER_BUSY-гейт для skill-runner. dispatch() глушит физ.ввод проактивной команды при активном
 * юзере, но skill.execute идёт мимо него — createClientActuator дёргает input.* напрямую. Прокидываем
 * тот же сигнал присутствия, чтобы проактивный навык НЕ трогал мышь/клаву, пока юзер сам за вводом.
 */
export interface ClientActuatorOptions {
  /** Навык запущен проактивно (Джарвис сам затеял) — гейтить физ.ввод при активном юзере. */
  isProactive?: boolean;
  /** Активен ли пользователь СЕЙЧАС (тот же userActiveNow, что в actuators/index.ts). */
  userActiveNow?: () => boolean;
}

export function createClientActuator(options: ClientActuatorOptions = {}): SkillActuator {
  const { isProactive = false, userActiveNow } = options;
  return {
    async executeStep(step: SkillStep): Promise<void> {
      // §H5: проактивный навык не инжектит физ.ввод, пока юзер сам за мышью/клавой — честный провал
      // шага (не ложный успех), раннер эскалирует/валит как обычную неудачу.
      if (isProactive && PHYSICAL_STEP_ACTIONS.has(step.action) && userActiveNow?.()) {
        throw new Error(
          `USER_BUSY: пользователь сам за вводом — физическую мышь/клавиатуру (${step.action}) сейчас не трогаю`,
        );
      }
      const p = step.params ?? {};
      switch (step.action) {
        case "app.launch":
          await apps.launchApp(str(p.app));
          return;
        case "app.focus":
          await apps.focusApp(str(p.app));
          return;
        case "browser.open":
          await apps.launchApp(str(p.url));
          return;
        case "ui.invoke":
          if (!step.target) throw new Error("ui.invoke без target");
          await ground.invoke(step.target, (p.pattern as UiPattern) ?? "invoke", str(p.value) || undefined);
          return;
        case "ui.ground":
          if (step.target?.by === "role") await ground.ground({ role: step.target.role, name: step.target.name });
          return;
        case "input.type":
          await input.typeText(str(p.text));
          return;
        case "input.key":
          await input.pressKey(str(p.combo));
          return;
        case "input.click":
          if (!step.target) throw new Error("input.click без target");
          // method из шага (§8 реплей-макрос пишет physical для игр/canvas — silent там заведомо слеп).
          await input.click(step.target, p.method === "physical" ? "physical" : "silent", true, {
            button: p.button === "right" || p.button === "middle" ? p.button : undefined,
            count: typeof p.count === "number" ? p.count : undefined,
          });
          return;
        case "input.mouse": {
          // §Волна2 (2.2/2.4): полная мышь в шаге берста/навыка (drag/wheel/hover/down-up).
          const op = String(p.op ?? "");
          if (op !== "move" && op !== "down" && op !== "up" && op !== "wheel" && op !== "drag") {
            throw new Error(`input.mouse: неизвестный op «${op}»`);
          }
          await input.mouse({
            op,
            x: typeof p.x === "number" ? p.x : undefined,
            y: typeof p.y === "number" ? p.y : undefined,
            toX: typeof p.toX === "number" ? p.toX : undefined,
            toY: typeof p.toY === "number" ? p.toY : undefined,
            button: p.button === "right" || p.button === "middle" ? p.button : undefined,
            dy: typeof p.dy === "number" ? p.dy : undefined,
            dx: typeof p.dx === "number" ? p.dx : undefined,
            space: p.space === "screen" ? "screen" : undefined,
          });
          return;
        }
        case "wait": {
          // Реальная пауза (§8 реплей-макрос: дать UI перерисоваться между кликами). Кламп — защита
          // от абсурдного ms в контенте навыка. Без ms — no-op (совместимость со старым смыслом wait).
          const ms = Math.min(15_000, Math.max(0, Number(p.ms) || 0));
          if (ms > 0) await sleep(ms);
          return;
        }
        case "ground":
        case "verify":
          // verify/ground выражаются через expect (auto-wait) — отдельного действия нет.
          return;
        default:
          log.warn(`неизвестное действие шага: ${step.action}`);
          return;
      }
    },

    async checkExpect(expect): Promise<boolean> {
      // VISUAL-постусловие (canvas/игры/видео без a11y): §Волна2 (2.3) — ЖИВАЯ локальная сверка
      // через OCR сайдкара (Windows.Media.Ocr): expect.text виден на экране → подтверждено.
      // Раньше был безусловный false → $0-реплей для игр был мёртв by design (каждый visual-шаг
      // эскалировал к LLM). ЧЕСТНОСТЬ цела: OCR не нашёл текст (или text не задан/сайдкар молчит)
      // → false → retry→эскалация к LLM с настоящими глазами, НЕ ложный успех.
      if (expect.kind === "visual") {
        const needle = (expect.text ?? "").trim().toLowerCase();
        if (!needle) return false;
        try {
          const { screenOcr } = await import("../actuators/sensors-cheap.js");
          const ocr = await screenOcr();
          return ocr.text.toLowerCase().includes(needle);
        } catch (e) {
          log.debug(`visual-expect: OCR недоступен (${e instanceof Error ? e.message : String(e)}) — эскалация к LLM`);
          return false;
        }
      }
      // Постусловие a11y: элемент с ролью/именем присутствует в UIA-дереве (§6 auto-wait).
      if (!expect.role) return true;
      try {
        await ground.ground({ role: expect.role, name: expect.name });
        return true;
      } catch {
        return false;
      }
    },
  };
}
