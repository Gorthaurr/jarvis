/**
 * Клиентский SkillActuator (§8): мапит шаги навыка на реальные актуаторы.
 *
 * executeStep — ground+действие через сайдкар/apps; checkExpect — проверка
 * постусловия через UIA-грундинг (элемент с role/name существует). Без сайдкара
 * UIA-шаги бросают/возвращают false — раннер корректно деградирует.
 */
import type { SkillStep } from "@jarvis/protocol";
import type { UiPattern } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import * as apps from "../actuators/apps.js";
import * as ground from "../actuators/ground.js";
import * as input from "../actuators/input.js";
import type { SkillActuator } from "./index.js";

const log = createLogger("skill-actuator");

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined ? "" : String(v);
}

export function createClientActuator(): SkillActuator {
  return {
    async executeStep(step: SkillStep): Promise<void> {
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
          await input.click(step.target);
          return;
        case "ground":
        case "verify":
        case "wait":
          // verify/ground/wait выражаются через expect (auto-wait) — отдельного действия нет.
          return;
        default:
          log.warn(`неизвестное действие шага: ${step.action}`);
          return;
      }
    },

    async checkExpect(expect): Promise<boolean> {
      // Постусловие: элемент с ролью/именем присутствует в a11y-дереве (§6 auto-wait).
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
