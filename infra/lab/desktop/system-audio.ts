/**
 * Звук FakeDesktop: «идёт ли звук» и пер-приложные сессии (audio.sessions / audio.set) — модель audio-sessions.ts клиента.
 * Единственный источник правды о звуке — `core.media.playing` + общая громкость/mute: звучит ли ПК, определяется ими; сессии
 * из `core.audioSessions` — строки микшера (кто «держит» поток). Пока медиа играет, звучит каждая не заглушённая сессия с
 * громкостью > 0 (какая именно — данные FakeDesktop не различают). Громкость сессии — 0..1, как у Core Audio; значение > 1
 * (кто-то положил проценты) читается как проценты. Сессии после reset() пусты и сидом не задаются: их кладёт GUI-половина
 * (запуск приложения) или тест.
 */
import type { AudioSession, DesktopCore, KindHandlers } from "./core.js";
import { handler, round } from "./system-common.js";

/** Порог «звук есть» — тот же, что у клиента (pauseKeyNeeded: peak > 0.001). */
export const PEAK_EPS = 0.001;

/** Слышно ли на выходе: медиа играет, не выключен звук, громкость не ноль. */
export const audible = (core: DesktopCore): boolean => core.media.playing && !core.muted && core.volume > 0;

/** Пик выхода (WASAPI-подобный, 0..1): пропорционален общей громкости, 0 в тишине. */
export const devicePeak = (core: DesktopCore): number => (audible(core) ? round((0.6 * core.volume) / 100, 4) : 0);

const vol01 = (s: AudioSession): number => (s.volume > 1 ? s.volume / 100 : s.volume);
const procOf = (s: AudioSession): string => s.name.replace(/\.exe$/iu, "");
const active = (core: DesktopCore, s: AudioSession): boolean => audible(core) && !s.muted && vol01(s) > 0;

export function audioHandlers(core: DesktopCore): KindHandlers {
  return {
    "audio.sessions": handler<"audio.sessions">(core, () => {
      const list = core.audioSessions.map((s) => {
        const on = active(core, s);
        return { pid: s.pid, process: procOf(s), title: "", state: on ? ("active" as const) : ("inactive" as const), muted: s.muted, volume: round(vol01(s), 3), peak: on ? round(0.5 * vol01(s), 4) : 0 };
      });
      // Как parseSessions клиента: сперва то, что звучит (пик), затем активные — «что это за звук» отвечает первая строка.
      return { sessions: list.sort((a, b) => b.peak - a.peak || Number(b.state === "active") - Number(a.state === "active")) };
    }),

    "audio.set": handler<"audio.set">(core, (c) => {
      const proc = (c.process ?? "").trim().replace(/\.exe$/iu, "");
      if (!c.pid && !proc) throw new Error("не указано, какому приложению менять звук (pid или process)");
      if (c.mute === undefined && c.level === undefined) throw new Error("не указано, что менять: mute или level");
      const level = c.level === undefined ? undefined : Math.max(0, Math.min(1, c.level));
      const hit = core.audioSessions.filter((s) => (c.pid ? s.pid === c.pid : false) || (proc !== "" && procOf(s).toLowerCase() === proc.toLowerCase()));
      if (hit.length === 0) throw new Error(`у «${c.pid ? `pid ${c.pid}` : proc}» нет активной звуковой сессии — глушить нечего (приложение молчит или закрыто)`);
      for (const s of hit) {
        if (c.mute !== undefined) s.muted = c.mute;
        if (level !== undefined) s.volume = level;
      }
      const sessions = hit.map((s) => ({ pid: s.pid, process: procOf(s), muted: s.muted, volume: round(vol01(s), 3) }));
      core.effect("audio.set", { sessions, ...(c.mute !== undefined ? { mute: c.mute } : {}), ...(level !== undefined ? { level } : {}) });
      return { touched: hit.length, sessions };
    }),
  };
}
