/**
 * Интеграция W2 (план §5.2): СКВОЗНОЙ стенд «сервер ↔ клиент» в одном процессе. НАСТОЯЩИЙ серверный `dispatchTool`
 * (кадр задачи, §0-пролог, §14-гейт GUI, вопрос владельцу, ОДИН повтор с грантом, act{steps}) и НАСТОЯЩИЙ клиентский
 * dispatch в области серверной команды (`serverExecutor` — как транспорт); команда и ответ идут через JSON, как по
 * WebSocket. Фейки — только края: сайдкар (fake-sidecar), захват экрана (fake-capturer) и владелец (`confirm`).
 *
 * Подключение (моки — в тест-файле, они поднимаются над импортами и действуют и здесь):
 *   vi.mock("electron", async () => (await import("../test-support/fake-capturer.js")).fakeElectronModule());
 *   vi.mock("../actuators/sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());
 *   vi.mock("../actuators/messaging.js", () => ({ sendMessage: async () => ({ messageId: "1" }), configureSenders: () => undefined }));
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { VISION_CAPS } from "@jarvis/shared";
import { type ToolContext, type ToolResult, dispatchTool } from "../../../server/src/brain/tools/dispatch.js";
import { serverExecutor } from "../actuators/approval-scope.js";
import { dispatch } from "../actuators/index.js";

/** Вопрос владельцу и то, что к этому моменту УЖЕ ушло в сайдкар (мутации). */
export interface Asked {
  question: string;
  sentBefore: string[];
}

export interface Link {
  ctx: ToolContext;
  asked: Asked[];
  sent: ActionCommand[];
  tool: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
}

const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Сервер задачи, подключённый к клиенту. `answer` — ответ владельца на §14-вопрос; `sidecarOps` — что уже ушло в
 * сайдкар (для «вопрос ДО первой буквы»); `place` — что сервер знает о переднем плане (systemContext).
 */
export function linkServerToClient(opts: { answer: boolean; sidecarOps: () => string[]; place?: string }): Link {
  const exec = serverExecutor(dispatch);
  const asked: Asked[] = [];
  const sent: ActionCommand[] = [];
  let n = 0;
  const ctx = {
    session: {
      sendAction: async (cmd: ActionCommand): Promise<ActionResult> => {
        sent.push(cmd);
        return wire(await exec(`srv-${(n += 1)}`, wire(cmd)));
      },
    },
    userId: "owner",
    origin: "user",
    visionCap: VISION_CAPS.high,
    confirm: async (question: string) => {
      asked.push({ question, sentBefore: opts.sidecarOps() });
      return { approved: opts.answer, outcome: opts.answer ? ("approved" as const) : ("denied" as const) };
    },
    systemContext: () => (opts.place ? `На переднем плане: ${opts.place}` : ""),
  } as unknown as ToolContext;
  return { ctx, asked, sent, tool: (name, input) => dispatchTool(name, input, ctx) };
}
