/**
 * Кейсы звука по приложениям: фасад audio{op} и его канонические audio_sessions / audio_set. Микшер «ПК» (два chrome, spotify,
 * заглушённый discord) задаётся своим desktop — DesktopSeed аудио-сессий не умеет. Главное: audio_set возвращает ПЕРЕЧИТАННОЕ
 * состояние, «глушить нечего» — ошибка, а не «готово»; мьют не закрывает окно.
 */
import type { CaseStep, EffectCheck, ToolCase } from "../case-format.js";
import { MIXER, deskLab } from "./sys-fixtures.js";

const ON = { playing: true, title: "Трек" };
const mixer = deskLab({ media: ON, sessions: MIXER });
const set = (args: Record<string, unknown>): CaseStep => ({ tool: "audio_set", args });
const noSet: EffectCheck[] = [{ none: "audio.set" }];
const CHROME = { windows: [{ title: "YouTube — Chrome", process: "chrome" }] };

export const cases: ToolCase[] = [
  // ───────────── audio_sessions ─────────────
  {
    tool: "audio_sessions", name: "кто звучит: первым идёт громче всех (peak), заглушённый discord — inactive с peak 0",
    args: {}, lab: mixer, expect: { ok: true, actionKinds: ["audio.sessions"], effects: noSet, resultIncludes: [/"pid":4100[^}]*"peak":0\.5[\s\S]*"pid":4200[\s\S]*"pid":4104[\s\S]*"pid":4300[^}]*"muted":true[^}]*"peak":0/, '"process":"spotify"'] }, coversTool: "audio_sessions",
  },
  {
    tool: "audio_sessions", name: "тишина на устройстве: у всех peak 0 и state inactive (звучащих нет)",
    args: {}, lab: deskLab({ sessions: MIXER }), expect: { ok: true, resultIncludes: '"state":"inactive"', resultExcludes: [/"peak":0\.\d/, '"state":"active"'] }, coversTool: "audio_sessions",
  },
  {
    tool: "audio_sessions", name: "сессий нет — пустой список, не ошибка",
    args: {}, expect: { ok: true, resultIncludes: '"sessions":[]' }, coversTool: "audio_sessions",
  },
  {
    tool: "audio_sessions", name: "после мьюта chrome список это ПОКАЗЫВАЕТ: обе сессии muted:true и не звучат (сверка исхода)",
    args: {}, lab: mixer, before: [set({ process: "chrome", mute: true })], expect: { ok: true, resultIncludes: [/"pid":4100[^}]*"muted":true[^}]*"peak":0[,}]/, /"pid":4104[^}]*"muted":true/] }, coversTool: "audio_sessions",
  },
  {
    tool: "audio_sessions", name: "клиент упал — «не удалось», списка в ответе нет",
    args: {}, lab: deskLab({ sessions: MIXER, fault: { kind: "audio.sessions", mode: "error" } }), expect: { ok: false, resultIncludes: /не удалось: runtime/, resultExcludes: "spotify" }, coversTool: "audio_sessions",
  },

  // ───────────── audio_set ─────────────
  {
    tool: "audio_set", name: "mute по pid: задета ровно одна сессия, в ответе и эффекте перечитанное состояние; вторая вкладка звучит",
    args: { pid: 4100, mute: true }, lab: mixer,
    expect: { ok: true, actionKinds: ["audio.set"], resultIncludes: ['"touched":1', /"pid":4100[^}]*"muted":true/], resultExcludes: '"pid":4104', effects: [{ has: "audio.set", detail: { mute: true, sessions: [{ pid: 4100, process: "chrome", muted: true, volume: 1 }] } }] }, coversTool: "audio_set",
  },
  {
    tool: "audio_set", name: "по имени процесса (с .exe) задеты ВСЕ его сессии (touched:2)",
    args: { process: "chrome.exe", mute: true }, lab: mixer, expect: { ok: true, resultIncludes: '"touched":2', effects: [(fx) => fx.find((e) => e.kind === "audio.set")?.detail.sessions instanceof Array && (fx.find((e) => e.kind === "audio.set")!.detail.sessions as unknown[]).length === 2 || "в эффекте не две сессии"] }, coversTool: "audio_set",
  },
  {
    tool: "audio_set", name: "level 0.3 + mute:false: громкость приложения стала 0.3 и звук возвращён — по перечитанному",
    args: { process: "spotify", level: 0.3, mute: false }, lab: mixer, expect: { ok: true, resultIncludes: /"process":"spotify"[^}]*"muted":false[^}]*"volume":0\.3/ }, coversTool: "audio_set",
  },
  {
    tool: "audio_set", name: "вернуть звук заглушённому discord: mute:false — muted:false в перечитанном",
    args: { process: "discord", mute: false }, lab: mixer, expect: { ok: true, resultIncludes: /"process":"discord"[^}]*"muted":false/ }, coversTool: "audio_set",
  },
  {
    tool: "audio_set", name: "мьют приложения НЕ закрывает его окно: окно chrome на месте, app.close не было",
    args: { process: "chrome", mute: true }, lab: deskLab({ media: ON, sessions: MIXER, seed: CHROME }),
    expect: { ok: true, effects: [{ none: "app.close" }], state: (s) => s.windows.some((w) => w.process === "chrome") || "окно chrome закрыто" }, coversTool: "audio_set",
  },
  {
    tool: "audio_set", name: "у процесса нет сессии — ЧЕСТНАЯ ошибка «глушить нечего», а не «готово»",
    args: { process: "telegram", mute: true }, lab: mixer, expect: { ok: false, resultIncludes: /глушить нечего/, effects: noSet }, coversTool: "audio_set",
  },
  {
    tool: "audio_set", name: "pid без сессии — ошибка, ни одна сессия не тронута",
    args: { pid: 9999, mute: true }, lab: mixer, expect: { ok: false, resultIncludes: /глушить нечего/, effects: noSet }, coversTool: "audio_set",
  },
  {
    tool: "audio_set", name: "цель не названа (только mute) — ошибка «какому приложению», ничего не заглушено",
    args: { mute: true }, lab: mixer, expect: { ok: false, resultIncludes: /какому приложению/, effects: noSet }, coversTool: "audio_set",
  },
  {
    tool: "audio_set", name: "цель есть, а что менять не названо — ошибка «mute или level»",
    args: { pid: 4100 }, lab: mixer, expect: { ok: false, resultIncludes: /mute или level/, effects: noSet }, coversTool: "audio_set",
  },
  {
    tool: "audio_set", name: "клиент молчит (таймаут) — ошибка с timeout, ложного «touched» нет",
    args: { pid: 4100, mute: true }, lab: deskLab({ media: ON, sessions: MIXER, fault: { kind: "audio.set", mode: "silent" } }), expect: { ok: false, resultIncludes: /timeout/, resultExcludes: "touched" }, coversTool: "audio_set",
  },

  // ───────────── фасад audio ─────────────
  {
    tool: "audio", name: "audio{op:list} канонизируется в audio.sessions и видит микшер",
    args: { op: "list" }, lab: mixer, expect: { ok: true, actionKinds: ["audio.sessions"], resultIncludes: '"process":"chrome"' }, coversTool: "audio_sessions",
  },
  {
    tool: "audio", name: "audio{op:set} канонизируется в audio.set: spotify заглушён, остальные звучат",
    args: { op: "set", process: "spotify", mute: true }, lab: mixer, expect: { ok: true, actionKinds: ["audio.set"], effects: [{ has: "audio.set", detail: { mute: true } }], resultExcludes: "chrome" }, coversTool: "audio_set",
  },
  {
    tool: "audio", name: "неизвестный op — «Неизвестный инструмент», клиенту ничего не ушло",
    args: { op: "bogus" }, lab: mixer, expect: { ok: false, actionKinds: [], resultIncludes: "Неизвестный инструмент", effects: noSet }, coversTool: "audio",
  },
  {
    tool: "audio", name: "без op — не угадываем действие: ошибка, ничего не заглушено",
    args: { pid: 4100, mute: true }, lab: mixer, expect: { ok: false, actionKinds: [], resultIncludes: "Неизвестный инструмент", effects: noSet }, coversTool: "audio",
  },
  {
    tool: "audio", name: "audio{op:set} без цели — клиент отвечает ошибкой, фасад не подставляет «первую сессию»",
    args: { op: "set", mute: true }, lab: mixer, expect: { ok: false, actionKinds: ["audio.set"], resultIncludes: /какому приложению/, effects: noSet }, coversTool: "audio",
  },
];
