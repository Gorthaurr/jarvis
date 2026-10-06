/**
 * Общие части кейсов «связи» (comm-*.cases.ts): чаты веб-Telegram для seed, признак ложного «ушло», мок расширения
 * (почта/календарь) и гарды/согласия «от прошлых вызовов». Клиент с отказами — в comm-wire.ts.
 */
import { approveSend } from "../../../../apps/server/src/brain/consent.js";
import { peerIdentityKeys } from "../../../../apps/server/src/brain/messaging/resend-guard.js";
import type { ToolContext } from "../../../../apps/server/src/brain/tools/dispatch.js";
import { resendGuard } from "../../../../apps/server/src/brain/tools/handlers/send-guards.js";
import type { DesktopSeed } from "../../lib/contracts.js";
import type { EffectCheck } from "../case-format.js";

export const TG_FILE = "C:/Users/lab/.lab/telegram.json";

/** seed с чатами веб-Telegram (`loggedIn:false` — вход не выполнен). */
export function tgSeed(chats: Array<{ title: string; peerId?: string; messages?: Array<{ dir: "in" | "out"; text: string }> }>, loggedIn = true): DesktopSeed {
  return { files: { [TG_FILE]: JSON.stringify({ loggedIn, chats }) } };
}

export const KATYA = { title: "Катя Иванова", peerId: "7", messages: [{ dir: "in" as const, text: "ты когда придёшь?" }] };

/** Текст, которым инструмент ЗАЯВЛЯЕТ, что ушло («Отправлено …», «Отправил голосовое …»); «Не отправил …» — отказ, не подпадает. */
export const CLAIMS_SENT = /Отправлено|(?<!Не )Отправил[аи]?\s/u;

// ───────────────────────── состояние гардов и склейка ctx ─────────────────────────

let seq = 0;

export interface Prior {
  /** Отправки, уже лежащие в окне ресенд-гарда (как после прошлого вызова) — без реального ожидания cadence.minGap. */
  sends?: Array<{ channel: string; to: string; text: string; uncertain?: boolean }>;
  /** Согласия §14, уже данные ЭТИМ владельцем («можно слать Кате»). */
  consents?: Array<{ channel: string; to: string }>;
  /** Согласия ДРУГОГО владельца — изоляция: этот их видеть и отзывать не должен. */
  foreign?: Array<{ channel: string; to: string }>;
}

/** Состояние процесса, «оставшееся от прошлых вызовов». userId минтится заново на каждую лабораторию: гарды и согласия к нему привязаны. */
export function prior(p: Prior): Partial<ToolContext> {
  return {
    get userId() {
      const id = `comm-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
      for (const s of p.sends ?? []) resendGuard().record(id, s.channel, peerIdentityKeys({ names: [s.to] }), s.text, s.uncertain ? { uncertain: true } : undefined);
      for (const c of p.consents ?? []) void approveSend(id, c.channel, c.to);
      for (const c of p.foreign ?? []) void approveSend("comm-other-owner", c.channel, c.to);
      return id;
    },
  } as Partial<ToolContext>;
}

export const priorSend = (s: NonNullable<Prior["sends"]>[number]): Partial<ToolContext> => prior({ sends: [s] });

/** Склеить ctx-части, СОХРАНЯЯ геттеры (спред `{...a}` вычислил бы их сразу, при загрузке модуля). */
export function compose(...parts: Array<Partial<ToolContext>>): Partial<ToolContext> {
  return Object.defineProperties({}, Object.assign({}, ...parts.map((p) => Object.getOwnPropertyDescriptors(p)))) as Partial<ToolContext>;
}

// ───────────────────────── мок расширения Chrome (почта/календарь) ─────────────────────────

export interface ExtCall {
  what: "mail" | "calendar";
  open: boolean | undefined;
}
export interface ExtProbe {
  ctx: Partial<ToolContext>;
  /** Аргументы `open` каждого обращения к расширению (mail/calendar). */
  calls(): ExtCall[];
}

const notInLab = async (): Promise<never> => {
  throw new Error("мок расширения: вызов вне почты/календаря — в кейсе связи не нужен");
};

/** `ext` отдаётся геттером: журнал обращений свой у каждой лаборатории. */
export function extProbe(h: { mail?: (open?: boolean) => unknown; calendar?: (open?: boolean) => unknown }): ExtProbe {
  let calls: ExtCall[] = [];
  const ctx = {
    get ext() {
      calls = [];
      return {
        connected: true,
        openOrFocus: notInLab, tabRead: notInLab, tabInspect: notInLab, tabAct: notInLab, tabList: notInLab, tabClose: notInLab, exportCookies: notInLab,
        ...(h.mail ? { mailRead: async (open?: boolean) => (calls.push({ what: "mail", open }), h.mail!(open)) } : {}),
        ...(h.calendar ? { calendarRead: async (open?: boolean) => (calls.push({ what: "calendar", open }), h.calendar!(open)) } : {}),
      };
    },
  } as Partial<ToolContext>;
  return { ctx, calls: () => calls };
}

/** Инструмент обратился к расширению ровно один раз и с таким `open`. */
export const calledWith = (p: ExtProbe, what: ExtCall["what"], open: boolean): EffectCheck => () =>
  JSON.stringify(p.calls()) === JSON.stringify([{ what, open }]) || `обращения к расширению: ${JSON.stringify(p.calls())}, ждали [{${what}, open:${open}}]`;
