// W3 «Петля»: retrieval фактов + recall навыка + каталог навыков (параллельно, под таймаутами).
import { log, withTimeout } from "./util.js";
import type { AgentDeps, ReplySink } from "../types.js";
import { memoryMinScore } from "../../../memory/episodic.js";
import { type RecalledSkill, formatSkillCatalog } from "../../../memory/skills.js";

export async function retrieveContext(deps: AgentDeps, text: string, sink: ReplySink | undefined) {
  // Retrieval (§8 факты из эпизодической памяти) + recall навыка (§8 HERMES) — оба
  // НЕОБЯЗАТЕЛЬНЫ, под жёстким таймаутом (§10: лучше ответить без них, чем повесить ход на
  // медленной БД) и НЕЗАВИСИМЫ → гоним ПАРАЛЛЕЛЬНО. Раньше шли серией (до ~2с+2с лишней
  // задержки ПЕРЕД первым токеном LLM) — на realtime-пути это заметная мёртвая пауза.
  // На ГОЛОСОВОМ пути (sink) таймаут жёсткий: память НЕ должна держать первый токен. Бюджет 350мс
  // обычно ловит эмбеддинг+поиск, иначе отвечаем без пары фактов (модель добёрет memory_search при
  // надобности). На фоновом/текстовом пути (ack маскирует задержку) — полные 2с с памятью.
  // §10 латентность: память НЕ держит первый токен. Голос (sink) — жёсткие 350мс. Текст/фон без sink
  // раньше ждал до 2000мс перед LLM (заметная пауза в чат-вкладке); снижено до 700мс — обычно ловит
  // эмбеддинг+поиск, иначе модель добёрет memory_search сама. Env-тюн (универсальность).
  const ioTimeoutMs = sink ? 350 : Math.max(150, Number.parseInt(process.env.JARVIS_RETRIEVAL_TIMEOUT_MS ?? "", 10) || 700);
  // Б2 (микро-опт): пустой стор пользователя (новый юзер) → retrieval-поиск гарантированно вернёт []
  // ценой embed+ANN и 350мс-гонки на КАЖДОМ голосовом ходе. Дешёвая проверка hasEntries (LIMIT 1,
  // process-кэш → обычно мгновенно) пропускает бессмысленный поиск. Свой КОРОТКИЙ таймаут (не полный
  // бюджет) — чтобы не удваивать латентность голоса, если БД висит; при таймауте/ошибке → обычный search.
  const hasEntriesTimeoutMs = Math.min(ioTimeoutMs, 150);
  const factsP: Promise<string[]> = (deps.episodic.hasEntries
    ? withTimeout(deps.episodic.hasEntries(deps.userId), hasEntriesTimeoutMs).catch(() => true)
    : Promise.resolve(true)
  ).then((has) =>
    has
      ? withTimeout(deps.episodic.search(deps.userId, text, 5, memoryMinScore()), ioTimeoutMs)
          .then((hits) => hits.map((h) => h.episode.text))
          .catch((e) => {
            log.debug("retrieval пропущен (таймаут/ошибка)", e instanceof Error ? e.message : String(e));
            return [];
          })
      : [],
  );
  // Если навык найден — его процедура вшивается в системный промпт, и модель ей СЛЕДУЕТ.
  // §Волна3 (3.1): на ФОНОВОМ пути (без sink — earcon уже прозвучал, латентность замаскирована)
  // recall получает БОЛЬШЕ времени: в живом эпизоде $0-fast-path реплея сорвался ровно на холодных
  // 700мс первого recall после boot (e5 + кэш векторов ещё холодные) — задача ушла в 20 LLM-раундов.
  const recallTimeoutMs = sink
    ? ioTimeoutMs
    : Math.max(ioTimeoutMs, Math.min(10_000, Number.parseInt(process.env.JARVIS_RECALL_TIMEOUT_MS ?? "", 10) || 2_500));
  // Б6: recall навыка на разговорном ходе НАМЕРЕННО оставлен — вопрос вроде «как отправить X» тоже
  // conversational, но выигрывает от процедуры; главную стоимость болтовни ($0.19 у «да ты молодец»)
  // режет кап tool-раундов (HARD_STEP_CAP=3) и не-регистрация §20-задачей, а не отказ от дешёвого e5.
  const recallP: Promise<RecalledSkill | null> = deps.skills
    ? withTimeout(deps.skills.recall(deps.userId, text), recallTimeoutMs).catch((e) => {
        log.debug("recall навыка пропущен (таймаут/ошибка)", e instanceof Error ? e.message : String(e));
        return null;
      })
    : Promise.resolve(null);
  // §8 Фаза 3: каталог выученных навыков тянем ПАРАЛЛЕЛЬНО (без доп. латентности), используем ТОЛЬКО
  // при лексическом промахе recall — Claude сам применит подходящий по смыслу (без эмбеддингов).
  const catalogP: Promise<Array<{ name: string; when: string }>> = deps.skills?.learnedCatalog
    ? withTimeout(deps.skills.learnedCatalog(deps.userId), ioTimeoutMs).catch(() => [])
    : Promise.resolve([]);
  const [facts, recalled, catalog] = await Promise.all([factsP, recallP, catalogP]);
  if (recalled) log.info("recall навыка (§8)", { id: recalled.id, version: recalled.version });
  const skillCatalog = !recalled ? formatSkillCatalog(catalog) : "";
  return { facts, recalled, skillCatalog };
}
