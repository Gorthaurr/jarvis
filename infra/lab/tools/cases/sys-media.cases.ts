/**
 * Кейсы system_media: правило «пауза = ПЕРЕКЛЮЧАТЕЛЬ — жать, только если звук реально идёт» (иначе «стоп» запускает музыку),
 * state как честная сверка «играет ли» (peak), клавиши next/stop, и дефекты play/op вне enum. Медиа-сессия «ПК» задаётся
 * своим desktop (deskLab): DesktopSeed медиа не умеет.
 */
import type { ToolCase } from "../case-format.js";
import { deskLab } from "./sys-fixtures.js";

const PLAYING = { playing: true, title: "Трек" };
const PAUSED = { playing: false, title: "Трек" };
const media = (s: { media: { playing: boolean } }) => s.media.playing;

export const cases: ToolCase[] = [
  {
    tool: "system_media", name: "pause при звучащей музыке: клавиша нажата, музыка остановлена (эффект и состояние)",
    args: { op: "pause" }, lab: deskLab({ media: PLAYING }),
    expect: { ok: true, effects: [{ has: "system.media", detail: { op: "pause", pressed: true, changed: true, playing: false } }], state: (s) => !media(s) || "музыка продолжает играть" }, coversTool: "system_media",
  },
  {
    tool: "system_media", name: "pause в тишине: клавиша НЕ нажата (переключатель запустил бы музыку), ответ already:true",
    args: { op: "pause" }, lab: deskLab({ media: PAUSED }),
    expect: { ok: true, resultIncludes: ['"already":true', '"playing":false'], effects: [{ has: "system.media", detail: { op: "pause", pressed: false, reason: "silence" } }], state: (s) => !media(s) || "пауза включила музыку" }, coversTool: "system_media",
  },
  {
    tool: "system_media", name: "play при паузе: переключатель нажат, музыка пошла",
    args: { op: "play" }, lab: deskLab({ media: PAUSED }),
    expect: { ok: true, effects: [{ has: "system.media", detail: { op: "play", pressed: true, changed: true, playing: true } }], state: (s) => media(s) || "музыка не пошла" }, coversTool: "system_media",
  },
  {
    tool: "system_media", name: "state при звучащей музыке: playing:true и ненулевой peak, клавиши не нажимались",
    args: { op: "state" }, lab: deskLab({ media: PLAYING }),
    expect: { ok: true, resultIncludes: ['"playing":true', /"peak":0\.\d+/], effects: [{ none: "system.media" }] }, coversTool: "system_media",
  },
  {
    tool: "system_media", name: "state при заглушённом звуке: playing:false (модель лаборатории: mute = нет звука на выходе) — «играет» без звука не врём",
    args: { op: "state" }, lab: deskLab({ media: PLAYING }), before: [{ tool: "system_volume", args: { op: "mute" } }],
    expect: { ok: true, resultIncludes: ['"playing":false', '"peak":0'] }, coversTool: "system_media",
  },
  {
    tool: "system_media", name: "next при активной сессии: клавиша действует (changed:true), музыка продолжает играть",
    args: { op: "next" }, lab: deskLab({ media: PLAYING }), expect: { ok: true, effects: [{ has: "system.media", detail: { op: "next", key: "next", pressed: true, changed: true } }], state: (s) => media(s) || "музыка остановилась" }, coversTool: "system_media",
  },
  {
    tool: "system_media", name: "stop при звучащей музыке останавливает её",
    args: { op: "stop" }, lab: deskLab({ media: PLAYING }), expect: { ok: true, effects: [{ has: "system.media", detail: { op: "stop", changed: true, playing: false } }], state: (s) => !media(s) || "играет" }, coversTool: "system_media",
  },
  {
    tool: "system_media", name: "next без медиа-сессии: клавиша ушла вхолостую (changed:false) — эффект в лаборатории виден, ответ клиента ok",
    args: { op: "next" }, expect: { ok: true, actionKinds: ["system.media"], effects: [{ has: "system.media", detail: { op: "next", pressed: true, changed: false } }] }, coversTool: "system_media",
  },
  {
    tool: "system_media", name: "клиент упал на state — «не удалось», данных о звуке нет",
    args: { op: "state" }, lab: deskLab({ media: PLAYING, fault: { kind: "system.media", mode: "error" } }), expect: { ok: false, resultIncludes: /не удалось: runtime/, resultExcludes: '"playing"' }, coversTool: "system_media",
  },
  {
    tool: "system_media", name: "play, когда музыка уже играет, не должна её ПАУЗИТЬ",
    args: { op: "play" }, lab: deskLab({ media: PLAYING }),
    skip: "ДЕФЕКТ: system.ts planSystem — play и pause = один VK_MEDIA_PLAY_PAUSE; охраняется по пику только pause, play при звучащей музыке её останавливает",
    expect: { state: (s) => media(s) || "play остановил играющую музыку" }, coversTool: "system_media",
  },
  {
    tool: "system_media", name: "op вне enum (rewind) — ошибка, а не нажатие play/pause",
    args: { op: "rewind" }, lab: deskLab({ media: PLAYING }),
    skip: "ДЕФЕКТ (low): system.ts planSystem — любой неизвестный op падает в ветку VK.playPause; сервер enum не проверяет",
    expect: { ok: false, state: (s) => media(s) || "неизвестный op переключил музыку" }, coversTool: "system_media",
  },
];
