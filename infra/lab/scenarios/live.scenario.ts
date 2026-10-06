/**
 * Сценарии «только живьём»: им нужен владелец или железо, которого нет у лаборатории. Раннер их не гоняет и пишет в
 * «пропущено» с причиной; в матрице покрытия они проходят как live-only (описывают, ЧТО проверять руками), а не как доказанные.
 */
import { liveOnlyCheck } from "../eval/dsl.js";
import type { EvalScenario } from "../eval/types.js";

const live = (id: string, title: string, goal: string, covers: string[], liveOnly: string): EvalScenario => ({
  id, title, goal, tags: ["live"], covers, brain: "real", budget: { maxMs: 240_000 }, liveOnly, check: liveOnlyCheck,
});

export const scenarios: EvalScenario[] = [
  live("reminder-fires", "Напоминание сработало голосом", "Напомни мне через минуту выпить воды.", ["tool:set_reminder"],
    "срабатывание — реальное время и озвучка на динамики; у процесса сервера нет инъекции часов (Date.now), виртуальные часы FakeDesktop его не двигают. Постановка проверена сценарием reminder-in-10-min"),
  live("voice-wake-command", "Голосовая команда после «Джарвис»", "Джарвис, включи музыку.", ["tool:system_media", "intent:media"],
    "нужны микрофон, локальный KWS и живые динамики; аудио-стенд лаборатории (audio/) проверяет слух на WAV, но не звук в комнате"),
  live("chrome-live-mail", "Прочитать почту в моём Chrome", "Открой мою почту в Хроме и прочитай последнее письмо.", ["tool:browser_open", "tool:browser_read"],
    "нужен живой Chrome владельца с расширением и его входом в почту (пароль вводит Chrome, §0); браузерные руки лаборатории не подключены"),
  live("audio-per-app", "Заглушить одну программу", "Заглуши Спотифай, а звук в игре оставь.", ["tool:audio_set", "tool:audio_sessions"],
    "нужны реальные аудиосессии Core Audio/WASAPI разных программ; FakeDesktop моделирует микшер, но не поведение драйвера"),
  live("skill-by-demo", "Выучить навык показом", "Смотри, как я это делаю, и запомни.", ["tool:demo_record"],
    "запись показом требует sidecar-win (UIA) и владельца за ПК, который что-то делает мышью; словесный вариант — сценарий skill-by-words"),
];
