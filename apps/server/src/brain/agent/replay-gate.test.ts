import { describe, expect, it } from "vitest";
import { autoReplayBlocked, isMetaSkill, looksLikeCommandUtterance } from "./replay-gate.js";

/** Живой навык из форензики — генерик-триггер ложных реплеев. */
const CLOSE_APP = { name: "Закрыть приложение", when: "когда просят закрыть программу или окно" };

describe("replay-gate (§P0, форензика 2026-07-14): гейт слепого авто-реплея", () => {
  it("живые ложные эпизоды форензики БЛОКИРУЮТСЯ (мат/разговор/инструкция — не команды реплею)", () => {
    // 13.07 10:20:41 — мат в Discord → «закрыть приложение» sim 0.831 → реплей во время Доты
    expect(
      autoReplayBlocked({
        text: "Я тебе пизды сейчас дам, уёбище ты тупоголовая",
        recalled: { ...CLOSE_APP, recallSim: 0.831 },
        conversational: false,
        viaWake: true,
      }),
    ).toMatch(/sim/);
    // 13.07 13:16:53 — «я просираюсь от чернослива» sim 0.821
    expect(
      autoReplayBlocked({
        text: "Джарвис, я просираюсь от чернослива",
        recalled: { ...CLOSE_APP, recallSim: 0.821 },
        conversational: false,
        viaWake: true,
      }),
    ).toMatch(/sim/);
    // 14.07 12:06:54 — инструкция владельца, recall sim 0.847: и порог, и отсутствие командного глагола
    expect(
      autoReplayBlocked({
        text: "Не забывай уточнять у меня, кому писать",
        recalled: { name: "Написать сообщение", when: "когда просят написать кому-то", recallSim: 0.847 },
        conversational: false,
        viaWake: true,
      }),
    ).not.toBeNull();
  });

  it("легитимная команда с высоким sim и явным обращением ПРОХОДИТ", () => {
    expect(
      autoReplayBlocked({
        text: "запусти поиск в доте",
        recalled: { name: "Запустить поиск в доте", when: "когда просят найти матч в Dota 2", recallSim: 0.95 },
        conversational: false,
        viaWake: true,
      }),
    ).toBeNull();
    // канал без wake-семантики (dev.text) — viaWake undefined = явное обращение
    expect(
      autoReplayBlocked({
        text: "открой блокнот и напиши заметку",
        recalled: { name: "Открыть блокнот", when: "когда просят открыть блокнот", recallSim: 0.93 },
        conversational: false,
      }),
    ).toBeNull();
  });

  it("реплика из ОКНА разговора без «Джарвис» блокируется даже с идеальным sim (главный вход чужой речи)", () => {
    expect(
      autoReplayBlocked({
        text: "закрой приложение",
        recalled: { ...CLOSE_APP, recallSim: 0.99 },
        conversational: false,
        viaWake: false,
      }),
    ).toMatch(/окна разговора/);
  });

  it("conversational-ход (вопрос) не получает жестов", () => {
    expect(
      autoReplayBlocked({
        text: "а как закрыть приложение",
        recalled: { ...CLOSE_APP, recallSim: 0.95 },
        conversational: true,
        viaWake: true,
      }),
    ).toMatch(/conversational/);
  });

  it("лексический recall (без семантической уверенности) авто-реплей не получает", () => {
    expect(
      autoReplayBlocked({
        text: "закрой приложение",
        recalled: { ...CLOSE_APP },
        conversational: false,
        viaWake: true,
      }),
    ).toMatch(/лексический/);
  });

  it("мета-навык (про ЗАПИСЬ макросов/навыков) не реплеится; игровая лексика «макрос/скилл» — НЕ мета (ревью)", () => {
    expect(isMetaSkill("Писать надёжный макрос", "когда просят написать макрос")).toBe(true);
    expect(isMetaSkill("Сохранить навык", "когда прошу сохранить навык")).toBe(true);
    expect(isMetaSkill("Закрыть приложение", "когда просят закрыть программу")).toBe(false);
    // Ревью: игровые навыки владельца со словами «макрос/скилл» (Dota/MMO — целевой домен) — легитимны,
    // подстрочный матч навсегда лишал их $0-реплея.
    expect(isMetaSkill("Включить макрос фарма в доте", "когда прошу включить макрос фарма")).toBe(false);
    expect(isMetaSkill("Прокачать скиллы героя", "когда просят прокачать скиллы в доте")).toBe(false);
    // Ревью р2: несвязанные verb∧noun, подстроки без границ слова и причастия — НЕ мета.
    expect(isMetaSkill("Создать лобби в доте", "когда прошу создать лобби и прокачать скиллы")).toBe(false);
    expect(isMetaSkill("Сохранить билд скиллов", "когда прошу сохранить билд скиллов")).toBe(false);
    expect(isMetaSkill("Записать клип со скиллом", "когда прошу записать клип со скиллом")).toBe(false);
    expect(isMetaSkill("Открыть описание навыка в доте", "когда прошу открыть описание навыка")).toBe(false);
    expect(isMetaSkill("Включить макрос фарма", "когда прошу включить записанный макрос фарма в доте")).toBe(false);
    expect(isMetaSkill("Прокачать скиллы", "записанный порядок прокачки скиллов")).toBe(false);
    // Ревью р3: дефисный компаунд — игровое слово, не мета.
    expect(isMetaSkill("Записать скилл-шот", "когда прошу записать скилл-шот в доте")).toBe(false);
    // Ревью р3: окно фразы НЕ пересекает склейку name/when (поля проверяются раздельно).
    expect(isMetaSkill("Записать клип", "макрос OBS уже настроен")).toBe(false);
    expect(isMetaSkill("Записать клип", "когда макрос OBS настроен")).toBe(false);
    // Ревью р3: КРАТКИЕ причастия описывают макрос, а не действие записи — не мета.
    expect(isMetaSkill("Включить фарм", "записан макрос показом")).toBe(false);
    expect(isMetaSkill("Включить фарм", "процедура записана в макрос")).toBe(false);
    expect(isMetaSkill("Включить фарм", "создан макрос для фарма")).toBe(false);
    expect(isMetaSkill("Включить фарм", "сохранён макрос переключения")).toBe(false);
    // Ревью р4: Ё-формы причастий обучения — тоже описание макроса, не действие.
    expect(isMetaSkill("Включить макрос фарма", "запускает ранее обучённый макрос фарма")).toBe(false);
    expect(isMetaSkill("Включить фарм", "научённый макрос кликов")).toBe(false);
    // Ревью р3: глаголы ОБУЧЕНИЯ и приставочные формы записи — МЕТА (HERMES = самообучение навыками).
    expect(isMetaSkill("Выучить новый навык", "когда прошу выучить новый навык")).toBe(true);
    expect(isMetaSkill("Запомнить макрос кликов", "когда прошу запомнить макрос")).toBe(true);
    expect(isMetaSkill("Перезаписать макрос", "когда прошу перезаписать макрос")).toBe(true);
    expect(isMetaSkill("Напиши макрос", "когда говорю напиши макрос")).toBe(true);
    expect(
      autoReplayBlocked({
        text: "включи макрос фарма",
        recalled: { name: "Включить макрос фарма в доте", when: "когда прошу включить макрос фарма", recallSim: 0.95, recallSimRaw: 0.9 },
        conversational: false,
        viaWake: true,
      }),
    ).toBeNull();
    // 13.07 16:48 — разговор о базе данных → ×2 реплей 14-шагового «писать надёжный макрос»
    expect(
      autoReplayBlocked({
        text: "запиши там уже всё решено с базой",
        recalled: { name: "Писать надёжный макрос", when: "когда просят написать макрос", recallSim: 0.95 },
        conversational: false,
        viaWake: true,
      }),
    ).toMatch(/мета-навык/);
  });

  it("двойной порог (ревью): бусты лексики/платформы не протаскивают низкий СЫРОЙ косинус в слепые жесты", () => {
    // «запусти реплей в доте» vs навык «Запустить поиск в доте»: rawCos ~0.8 + лексика 0.13 + платформа 0.1
    // = гибрид ~1.03 ≥ 0.92 — но сырой косинус ниже raw-порога 0.84 → реплей ЧУЖОГО действия не уходит.
    const searchSkill = { name: "Запустить поиск в доте", when: "когда просят найти матч в Dota 2" };
    expect(
      autoReplayBlocked({
        text: "запусти реплей в доте",
        recalled: { ...searchSkill, recallSim: 1.03, recallSimRaw: 0.8 },
        conversational: false,
        viaWake: true,
      }),
    ).toMatch(/сырой косинус/);
    // Реально близкая команда: raw выше полосы шума (0.856+ у живых попаданий) → проходит
    expect(
      autoReplayBlocked({
        text: "запусти поиск в доте",
        recalled: { ...searchSkill, recallSim: 1.05, recallSimRaw: 0.86 },
        conversational: false,
        viaWake: true,
      }),
    ).toBeNull();
  });

  it("командный глагол: императивы команд ловятся, разговорная речь — нет", () => {
    for (const cmd of [
      "запусти поиск в доте",
      "открой блокнот",
      "напиши кате привет",
      "прокачай алхимику тридцатый уровень",
      "выключи музыку",
      "нажми пробел",
      // ревью: пробелы аллоулиста — частотные императивы, терявшие $0-реплей
      "добавь трек в избранное",
      "ответь диме что занят",
      "перемотай на минуту вперёд",
      "выбери второй вариант",
    ])
      expect(looksLikeCommandUtterance(cmd), cmd).toBe(true);
    for (const chat of [
      "я тебе пизды сейчас дам",
      "я просираюсь от чернослива",
      "там уже всё решено с базой",
      "не забывай уточнять у меня, кому писать",
      "какая сегодня погода",
    ])
      expect(looksLikeCommandUtterance(chat), chat).toBe(false);
  });

  it("порог sim настраиваемый: значение на границе дефолта 0.92 проходит, чуть ниже — нет", () => {
    const base = {
      text: "закрой приложение",
      recalled: { ...CLOSE_APP, recallSim: 0.92 },
      conversational: false,
      viaWake: true,
    };
    expect(autoReplayBlocked(base)).toBeNull();
    expect(autoReplayBlocked({ ...base, recalled: { ...CLOSE_APP, recallSim: 0.919 } })).toMatch(/sim/);
  });
});
