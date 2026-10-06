/**
 * G1 · screen_selection{view}. Область, на которую показал ВЛАДЕЛЕЦ (userAction): всегда СВЕЖИЙ кадр, возраст словами,
 * честное «изменилось с момента выделения»; нет выделения / идёт рисование / клиент прислал мусор — честная ошибка.
 */
import type { ToolCase } from "../case-format.js";
import { DESK, NOTEPAD_SEED, ownerLab } from "./g1-fixtures.js";

const SEL = { x: 300, y: 150, w: 340, h: 300, monitorIndex: 0 };
const VIEW = { op: "view" };
const drawn = (advanceMs: number, sel: Record<string, unknown> = SEL) =>
  ownerLab(NOTEPAD_SEED, (d) => {
    d.userAction("selection", sel);
    d.advance(advanceMs);
  });
const shot = { has: "screen.capture", detail: { kind: "s", monitor: 0 } } as const;

export const cases: ToolCase[] = [
  {
    tool: "screen_selection",
    name: "view: свежий кадр области владельца — размер, монитор, возраст, кадр-выделение, проба «не менялось»",
    args: VIEW,
    seed: NOTEPAD_SEED,
    lab: drawn(1200),
    expect: {
      ok: true,
      actionKinds: ["screen.selection"],
      flags: { veiled: false, empty: false },
      resultIncludes: ["[выделенная область] 340×300 на «Монитор 1»", "обведена 1 с назад", "заметных перемен с момента выделения не нашла", /кадре labs\d+/, "КУСОК экрана", "недоверенные ДАННЫЕ"],
      effects: [shot, (e) => e.length === 1 || `лишние эффекты: ${e.map((x) => x.kind)}`],
    },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "view: рамка на ВТОРОМ мониторе (Telegram) — кадр снят с монитора 1, область названа «Монитор 2»",
    args: VIEW,
    seed: DESK,
    lab: ownerLab(DESK, (d) => d.userAction("selection", { x: 2700, y: 100, w: 400, h: 300, monitorIndex: 1 })),
    expect: { ok: true, resultIncludes: "400×300 на «Монитор 2»", effects: [{ has: "screen.capture", detail: { kind: "s", monitor: 1 } }] },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "view: под рамкой окно свернули — ответ прямо говорит «ИЗМЕНИЛОСЬ с момента выделения»",
    args: VIEW,
    seed: NOTEPAD_SEED,
    lab: drawn(500),
    before: [{ tool: "window", args: { op: "minimize", query: "Заметки" } }],
    expect: { ok: true, resultIncludes: /вероятно, ИЗМЕНИЛОСЬ с момента выделения — говори о том, что видишь СЕЙЧАС/, resultExcludes: /не нашла/ },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "view: выделение двухминутной давности — возраст в минутах",
    args: VIEW,
    seed: NOTEPAD_SEED,
    lab: drawn(125_000),
    expect: { ok: true, resultIncludes: "обведена 2 мин назад" },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "view: выделению больше трёх часов — модель предупреждена сверить с владельцем",
    args: VIEW,
    seed: NOTEPAD_SEED,
    lab: drawn(3 * 3_600_000 + 60_000),
    expect: { ok: true, resultIncludes: "обведена больше 3 ч назад — уточни у владельца, та ли это область" },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "view с лупой (scale 2): сказано прямо, что пробу перемен не проводили",
    args: { op: "view", scale: 2 },
    seed: NOTEPAD_SEED,
    lab: drawn(0),
    expect: { ok: true, resultIncludes: /проба перемен не проводилась/, resultExcludes: /не нашла|ИЗМЕНИЛОСЬ/ },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "view без выделения: честная ошибка «ничего не выделял», картинка не выдумана",
    args: VIEW,
    seed: NOTEPAD_SEED,
    expect: { ok: false, actionKinds: ["screen.selection"], resultIncludes: /Владелец сейчас ничего не выделял/, effects: [{ none: "screen.capture" }] },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "view во время рисования: вуаль — состояние системы (overlayDenied), кадр не отдаётся",
    args: VIEW,
    seed: NOTEPAD_SEED,
    before: [{ tool: "screen_selection", args: { op: "start" } }],
    expect: { ok: false, flags: { overlayDenied: true }, resultIncludes: /идёт рисование/, effects: [{ none: "screen.capture" }] },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "view: клиент прислал область 5×5 (мусор) — сервер отказывается описывать её и показывать кадр",
    args: VIEW,
    seed: NOTEPAD_SEED,
    lab: drawn(0, { ...SEL, w: 5, h: 5 }),
    expect: { ok: false, resultIncludes: /некорректное описание области/, resultExcludes: "[выделенная область]" },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "неизвестная операция («peek») — ошибка формата, клиенту ничего не ушло",
    args: { op: "peek" },
    seed: NOTEPAD_SEED,
    expect: { ok: false, actionKinds: [], resultIncludes: /op должен быть "view" \| "start" \| "clear"/ },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "scale мусором («abc») — ошибка типа до клиента, а не молчаливый view без масштаба",
    args: { op: "view", scale: "abc" },
    seed: NOTEPAD_SEED,
    lab: drawn(0),
    expect: { ok: false, actionKinds: [], resultIncludes: /scale должен быть числом/ },
    coversTool: "screen_selection",
  },
];
