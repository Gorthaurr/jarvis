/**
 * Клиент ПК с ОТКАЗАМИ для кейсов «связи» (comm-*.cases.ts).
 *
 * Харнесс не умеет терять ответы клиента (опции FakeDesktop глобальны, а кейс — данные), а третий исход отправки
 * («ушло, а ответа нет») без этого не проверить. Обёртка гонит команды в НАСТОЯЩИЙ FakeDesktop и лишь портит ответ:
 *  - `lose-reply` — клиент СДЕЛАЛ (в чате сообщение есть), ответ пропал (timeout);
 *  - `drop`       — до клиента не дошло (код ошибки на выбор), на «ПК» ничего не изменилось;
 *  - `answer`     — клиент отвечает заранее заданным успехом, «ПК» не трогается (то, что FakeDesktop не умеет: order.place);
 *  - `sleep`      — команда спит (реальное время между двумя отправками: cadence.minGap = 3 с).
 * ctx отдаётся геттером: каждая лаборатория (и повторный прогон кейса) получает свежие «ПК», журнал и счётчики.
 * Расширение (фолбэк telegramSend) и голос (synthVoice/telegramSendVoice) — мок с журналом, поведение задаёт `extras`.
 */
import type { ActionCommand, ActionResult } from "../../../../packages/protocol/src/index.js";
import type { ToolContext } from "../../../../apps/server/src/brain/tools/dispatch.js";
import { extNoReplyError } from "../../../../apps/server/src/brain/tools/ext-errors.js";
import { createFakeDesktop } from "../../desktop/index.js";
import type { DesktopEffect, DesktopSeed, FakeDesktop } from "../../lib/contracts.js";
import type { CaseStep, EffectCheck } from "../case-format.js";

export type ErrCode = "timeout" | "disconnected" | "channel_down" | "runtime";
export type Fault =
  | { kind: string; mode: "lose-reply"; times?: number }
  | { kind: string; mode: "drop"; code?: ErrCode; message?: string; times?: number }
  | { kind: string; mode: "answer"; data: unknown; times?: number }
  | { kind: string; mode: "sleep"; ms: number };

export interface Extras {
  /** Фолбэк-отправка через расширение: ok — отправило, fail — упало. Нет — ctx.telegramSend не задан. */
  telegramSend?: "ok" | "fail";
  /** Голосовое: ok / fail (расширение упало до отправки) / no-reply (запрос ушёл, ответа нет). Нет — TTS не подключён. */
  voice?: "ok" | "fail" | "no-reply";
  /** Поверх экрана вуаль режима выделения (ctx.veilDrawing) — фолбэк через расширение отобрал бы клавиатуру у рамки. */
  veil?: boolean;
}

export interface Wire {
  ctx: Partial<ToolContext>;
  /** Виды команд, дошедших до сессии (включая `before`). */
  kinds(): string[];
  commands(): ActionCommand[];
  effects(): DesktopEffect[];
  /** Тексты, отправленные фолбэком-расширением / получатели голосовых. */
  extSends(): string[];
  voiceSends(): string[];
}

const fail = (commandId: string, code: ErrCode, message: string): ActionResult => ({ commandId, ok: false, durationMs: 0, error: { code, message } });
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function faultyClient(seed: DesktopSeed | undefined, faults: Fault[] = [], extras: Extras = {}): Wire {
  let desktop: FakeDesktop = createFakeDesktop(seed);
  let log: ActionCommand[] = [];
  let left: number[] = [];
  let ext: string[] = [];
  let voice: string[] = [];
  const session = {
    async sendAction(cmd: ActionCommand): Promise<ActionResult> {
      log.push(cmd);
      const meta = { commandId: `wire-${log.length}`, timeoutMs: 1000 };
      const i = faults.findIndex((f, k) => f.kind === cmd.kind && (left[k] ?? 0) > 0);
      const f = i >= 0 ? faults[i] : undefined;
      if (!f) return desktop.handle(cmd, meta);
      left[i] = (left[i] ?? 0) - 1;
      if (f.mode === "sleep") await pause(f.ms);
      if (f.mode === "lose-reply") {
        await desktop.handle(cmd, meta);
        return fail(meta.commandId, "timeout", "нет result за 90000ms");
      }
      if (f.mode === "answer") return { commandId: meta.commandId, ok: true, durationMs: 1, data: f.data };
      if (f.mode === "drop") return fail(meta.commandId, f.code ?? "runtime", f.message ?? `сбой доставки ${cmd.kind}`);
      return desktop.handle(cmd, meta);
    },
  };
  const parts: Partial<ToolContext> = {
    ...(extras.veil ? { veilDrawing: () => true } : {}),
    ...(extras.telegramSend
      ? { telegramSend: async (to: string, text: string) => (ext.push(text), extras.telegramSend === "ok" ? { chatTitle: to } : Promise.reject(new Error("расширение: вкладка Telegram не открыта"))) }
      : {}),
    ...(extras.voice
      ? {
          synthVoice: async () => "bXAzLWJhc2U2NA==",
          telegramSendVoice: async (to: string) => {
            voice.push(to);
            if (extras.voice === "fail") throw new Error("расширение: Telegram не открыт");
            if (extras.voice === "no-reply") throw extNoReplyError("нет ответа расширения за 60000ms");
            return { ok: true };
          },
        }
      : {}),
  };
  const ctx = {
    ...parts,
    get session() {
      desktop = createFakeDesktop(seed);
      log = [];
      ext = [];
      voice = [];
      left = faults.map((f) => (f.mode === "sleep" ? Number.POSITIVE_INFINITY : (f.times ?? Number.POSITIVE_INFINITY)));
      return session;
    },
  } as Partial<ToolContext>;
  return { ctx, kinds: () => log.map((c) => c.kind), commands: () => [...log], effects: () => desktop.snapshot().effects, extSends: () => [...ext], voiceSends: () => [...voice] };
}

/** «Прошло >3 с» между двумя отправками (cadence.minGap): шаг, чей клиентский вызов спит. */
export const PASS_TIME: Fault = { kind: "fs.list", mode: "sleep", ms: 3100 };
export const PASS_TIME_STEP: CaseStep = { tool: "fs_list", args: { path: "C:/Users/lab" } };

const same = (a: readonly string[], b: readonly string[]): boolean => a.join(",") === b.join(",");

/** Точная последовательность команд, дошедших до клиента (то же, что `expect.actionKinds`, но для обёртки). */
export const sentKinds = (w: Wire, expected: string[]): EffectCheck => () => same(w.kinds(), expected) || `клиенту ушло [${w.kinds().join(", ")}], ждали [${expected.join(", ")}]`;

/** Сколько эффектов вида `kind` осталось на «ПК» обёртки (доказательство: ушло/не ушло в реальности). */
export const wireEffects = (w: Wire, kind: string, count: number, detail?: Record<string, unknown>): EffectCheck => () => {
  const hit = w.effects().filter((e) => e.kind === kind && (detail === undefined || Object.entries(detail).every(([k, v]) => e.detail[k] === v)));
  return hit.length === count || `эффектов ${kind}${detail ? ` ${JSON.stringify(detail)}` : ""}: ${hit.length}, ждали ${count}`;
};

/** Счётчик побочных вызовов мока (фолбэк-расширение / голос): точное число, а не «хоть раз». */
export const exactly = (what: string, got: () => string[], n: number): EffectCheck => () => got().length === n || `${what}: ${got().length} (${got().join(" | ")}), ждали ${n}`;

/** Первая команда вида `kind` несёт ровно такие значения полей (payload дошёл до клиента, а не только «команда была»). */
export const sentPayload = (w: Wire, kind: string, want: Record<string, unknown>): EffectCheck => () => {
  const c = w.commands().find((x) => x.kind === kind) as Record<string, unknown> | undefined;
  return (c !== undefined && Object.entries(want).every(([k, v]) => JSON.stringify(c[k]) === JSON.stringify(v))) || `команда ${kind}: ${JSON.stringify(c)}, ждали ⊇ ${JSON.stringify(want)}`;
};
