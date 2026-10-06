/**
 * G1 · screen_probe («изменилось ли на экране»). Хеш — детектор перемен, не доказательство результата: то же изображение
 * даёт тот же хеш, другое — другой; регион только в кадре задачи; под вуалью проба измеряет оверлей.
 * Эталонные хеши считает сам FakeDesktop (fakeData) — сервер обязан отдать ровно то, что дал бы клиент.
 */
import type { ToolCase } from "../case-format.js";
import { NOTEPAD_SEED, fakeData } from "./g1-fixtures.js";

const CAPTURE = { kind: "screen.capture", monitor: 0 };
const EMPTY = (await fakeData({}, [{ kind: "screen.probe", monitor: 0 }])).hash as string;
const WITH_NOTEPAD = (await fakeData({}, [{ kind: "app.launch", app: "notepad" }, { kind: "screen.probe", monitor: 0 }])).hash as string;
const REGION = (await fakeData(NOTEPAD_SEED, [CAPTURE, { kind: "screen.probe", rect: { x: 100, y: 60, w: 300, h: 200, frame: "labf1" } }])).hash as string;
const readOnly: NonNullable<ToolCase["expect"]["effects"]> = [(e) => e.length === 0 || `эффекты у пробы: ${e.map((x) => x.kind).join(", ")}`];

export const cases: ToolCase[] = [
  {
    tool: "screen_probe",
    name: "пустой рабочий стол: хеш формата 8×8 и средняя яркость, следов на «ПК» нет",
    args: { monitor: "0" },
    expect: { ok: true, actionKinds: ["screen.probe"], resultIncludes: [`"hash":"${EMPTY}"`, /"mean":\d+,"width":256,"height":144/], effects: readOnly },
    coversTool: "screen_probe",
  },
  {
    tool: "screen_probe",
    name: "после запуска блокнота хеш ДРУГОЙ (перемена замечена) и равен хешу такого же стола",
    args: { monitor: "0" },
    before: [{ tool: "app_launch", args: { app: "notepad" } }],
    expect: { ok: true, resultIncludes: `"hash":"${WITH_NOTEPAD}"`, resultExcludes: EMPTY },
    coversTool: "screen_probe",
  },
  {
    tool: "screen_probe",
    name: "регион в кадре задачи: сервер сам подставляет кадр — хеш равен хешу того же региона у клиента",
    args: { monitor: "0", rect: { x: 100, y: 60, w: 300, h: 200 } },
    seed: NOTEPAD_SEED,
    before: [{ tool: "screen_capture", args: { monitor: "0" } }],
    expect: { ok: true, actionKinds: ["screen.probe"], resultIncludes: `"hash":"${REGION}"`, resultExcludes: EMPTY },
    coversTool: "screen_probe",
  },
  {
    tool: "screen_probe",
    name: "rect без кадра задачи — отказ до клиента, хеш не выдумывается",
    args: { rect: { x: 1, y: 1, w: 50, h: 50 } },
    seed: NOTEPAD_SEED,
    expect: { ok: false, actionKinds: [], resultIncludes: /координаты без кадра/, resultExcludes: /"hash"/ },
    coversTool: "screen_probe",
  },
  {
    tool: "screen_probe",
    name: "регион вне кадра — честный not_found, а не хеш «чего-то»",
    args: { monitor: "0", rect: { x: 90000, y: 10, w: 50, h: 50 } },
    seed: NOTEPAD_SEED,
    before: [{ tool: "screen_capture", args: { monitor: "0" } }],
    expect: { ok: false, resultIncludes: /not_found.*вне кадра/, resultExcludes: /"hash"/ },
    coversTool: "screen_probe",
  },
  {
    tool: "screen_probe",
    name: "несуществующий монитор 9 — ошибка с числом мониторов",
    args: { monitor: "9" },
    expect: { ok: false, actionKinds: ["screen.probe"], resultIncludes: /монитора «9» нет \(всего 2\)/, resultExcludes: /"hash"/ },
    coversTool: "screen_probe",
  },
  {
    tool: "screen_probe",
    name: "под вуалью выделения хеш снят с оверлея: veiled, empty, «не сверка»",
    args: { monitor: "0" },
    seed: NOTEPAD_SEED,
    before: [{ tool: "screen_selection", args: { op: "start" } }],
    expect: { ok: true, flags: { veiled: true, empty: true }, resultIncludes: ["СНЯТО ПОД ВУАЛЬЮ", "НЕ сверка исхода"] },
    coversTool: "screen_probe",
  },
];
