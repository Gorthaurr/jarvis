/**
 * system.* FakeDesktop — модель system.ts клиента БЕЗ единого вызова ОС: питание/блокировка только пишут эффект и состояние
 * (реальный ПК не выключается и не блокируется никогда), громкость/медиа/буфер/раскладка меняют состояние ядра.
 * Сохранены ЧЕСТНЫЕ и НЕДОСТАТОЧНО честные повадки настоящего актуатора: shutdown/restart — только отложенно (25 с, окно
 * отмены), `play` и `pause` жмут один переключатель (pause в тишине — no-op без клавиши), `mute` — тумблер, set сверяет
 * readback и после установки может бросить (громкость при этом уже изменена).
 */
import { pauseKeyNeeded } from "../../../apps/client/main/actuators/system.js";
import type { DesktopCore, KindHandlers } from "./core.js";
import { devicePeak, PEAK_EPS } from "./system-audio.js";
import { handler } from "./system-common.js";

const SHUTDOWN_DELAY_SEC = 25;
const DEFAULT_LAYOUT: "ru" | "en" = "ru";

/** Банковское округление, как `[math]::Round` в PowerShell (ToEven): 12.5 → 12. */
const roundEven = (x: number): number => {
  const f = Math.floor(x);
  const d = x - f;
  return d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
};
/** Уровень «через Core Audio»: 0..1 → float32 → проценты, как читает Vol::Get. */
const readback = (scalar: number): number => roundEven(Math.fround(scalar) * 100);

/** Ожидающее shutdown/restart: последнее system.power без отмены после него и с ещё не истёкшим окном. Состояние — в effects. */
function pendingPower(core: DesktopCore): { op: string; deadlineAt: number } | null {
  for (let i = core.effects.length - 1; i >= 0; i -= 1) {
    const e = core.effects[i]!;
    if (e.kind !== "system.power") continue;
    if (e.detail.op === "cancel") return null;
    if (e.detail.op === "shutdown" || e.detail.op === "restart") {
      const deadlineAt = Number(e.detail.deadlineAt);
      return deadlineAt > core.now() ? { op: String(e.detail.op), deadlineAt } : null;
    }
  }
  return null;
}

/** Раскладка активного окна — из журнала эффектов (сбрасывается вместе с reset). */
function currentLayout(core: DesktopCore): "ru" | "en" {
  const hwnd = core.foreground ?? 0;
  for (let i = core.effects.length - 1; i >= 0; i -= 1) {
    const e = core.effects[i]!;
    if (e.kind === "system.layout" && e.detail.hwnd === hwnd) return e.detail.to === "en" ? "en" : "ru";
  }
  return DEFAULT_LAYOUT;
}

export function sysHandlers(core: DesktopCore): KindHandlers {
  return {
    "system.lock": handler<"system.lock">(core, () => {
      core.effect("system.lock", { wasLocked: core.locked });
      core.locked = true;
      return { ok: true };
    }),

    "system.power": handler<"system.power">(core, (c) => {
      switch (c.op) {
        case "sleep":
        case "logoff":
          core.effect("system.power", { op: c.op, immediate: true });
          break;
        case "shutdown":
        case "restart": {
          if (pendingPower(core)) throw new Error("shutdown вернул код 1190: A system shutdown has already been scheduled.(1190)");
          const what = c.op === "shutdown" ? "выключение" : "перезагрузка";
          core.effect("system.power", { op: c.op, delaySec: SHUTDOWN_DELAY_SEC, deadlineAt: core.now() + SHUTDOWN_DELAY_SEC * 1000, warning: `Джарвис: ${what} через ${SHUTDOWN_DELAY_SEC} сек. Передумали — скажите «отмена».` });
          break;
        }
        case "cancel":
          core.effect("system.power", { op: "cancel", hadPending: pendingPower(core) !== null });
          break;
        default:
          throw new Error(`unknown system command: ${JSON.stringify(c)}`);
      }
      return { ok: true };
    }),

    "system.media": handler<"system.media">(core, (c) => {
      const peak = devicePeak(core);
      if (c.op === "state") return { ok: true, playing: peak > PEAK_EPS, peak };
      if (c.op === "pause" && !pauseKeyNeeded(peak)) {
        // Переключатель в тишине ЗАПУСТИЛ бы музыку — клавишу не жмём (ревью 2026-09-24, B-F2).
        core.effect("system.media", { op: "pause", pressed: false, reason: "silence", playing: core.media.playing });
        return { ok: true, playing: false, already: true, peak };
      }
      const key = c.op === "next" ? "next" : c.op === "prev" ? "prev" : c.op === "stop" ? "stop" : "play_pause";
      const hasSession = core.media.playing || core.media.title !== undefined;
      let changed = false;
      if (key === "play_pause" && hasSession) { core.media.playing = !core.media.playing; changed = true; }
      else if (key === "stop" && core.media.playing) { core.media.playing = false; changed = true; }
      else if ((key === "next" || key === "prev") && hasSession) changed = true;
      core.effect("system.media", { op: c.op, key, pressed: true, changed, playing: core.media.playing, ...(core.media.title ? { title: core.media.title } : {}) });
      return { ok: true };
    }),

    "system.volume": handler<"system.volume">(core, (c) => {
      const from = core.volume;
      const done = (extra: Record<string, unknown> = {}): void => core.effect("system.volume", { op: c.op, from, level: core.volume, muted: core.muted, ...extra });
      if (c.op === "get") return { ok: true, level: core.volume };
      if (c.op === "mute") {
        core.muted = !core.muted; // SetMute(-not $m): тумблер, не установка
        done();
        return { ok: true, muted: core.muted };
      }
      if (c.op === "set") {
        const raw = c.level ?? 50;
        const safe = Number.isFinite(raw) ? raw : 50;
        core.volume = readback(Number((Math.min(100, Math.max(0, safe)) / 100).toFixed(3)));
        done({ requested: c.level ?? null });
        // Сверка readback: не сошлось → ЧЕСТНЫЙ провал, хотя громкость уже стоит (как у клиента).
        if (c.level != null && (!Number.isFinite(c.level) || Math.abs(core.volume - c.level) > 3)) {
          throw new Error(`громкость не установилась: просил ${c.level}, по факту ${core.volume}`);
        }
        return { ok: true, level: core.volume };
      }
      if (c.op === "up" || c.op === "down") {
        const n = Math.max(0, Math.min(1, Math.fround(core.volume / 100) + (c.op === "up" ? 0.1 : -0.1)));
        core.volume = readback(n);
        done();
        return { ok: true, level: core.volume };
      }
      throw new Error(`unknown system command: ${JSON.stringify(c)}`);
    }),

    "system.clipboard": handler<"system.clipboard">(core, (c) => {
      if (c.op === "read") return { ok: true, stdout: core.clipboard };
      core.clipboard = c.text ?? "";
      core.effect("clipboard.write", { via: "system.clipboard", length: core.clipboard.length, text: core.clipboard });
      return { ok: true };
    }),

    "system.layout": handler<"system.layout">(core, (c) => {
      if (c.lang !== "en" && c.lang !== "ru" && c.lang !== "toggle") throw new Error(`unknown system command: ${JSON.stringify(c)}`);
      const from = currentLayout(core);
      const to = c.lang === "toggle" ? (from === "ru" ? "en" : "ru") : c.lang;
      core.effect("system.layout", { hwnd: core.foreground ?? 0, from, to, changed: from !== to });
      return { ok: true, stdout: to };
    }),
  };
}
