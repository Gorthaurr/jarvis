// W3 «Петля»: retrieval фактов + recall навыка + каталог навыков (параллельно, под таймаутами).
import { log, suppressSkillHint, withTimeout } from "./util.js";
import type { AgentDeps, ReplySink } from "../types.js";
import { memoryMinScore } from "../../../memory/episodic.js";
import { type RecalledSkill, formatSkillCatalog } from "../../../memory/skills.js";
import { hasCommandVerb } from "../../router/index.js";

/**
 * Ревью 2026-09-24 (T-F2): порог СЫРОГО косинуса для подсказки навыка в промпт. Строже реплея (0.84): у реплея
 * есть второй порог (гибрид ≥0.92) и командный глагол, а подсказка раньше шла на ЛЮБОЙ recall ≥0.82 — живой лог:
 * sim 0.84–1.0 на «нет, не надо», и приказ «ИСПОЛНИ» уводил модель в браузер. 0.86 — выше задокументированной
 * полосы шума e5-small (несвязанные 0.82–0.85), на уровне живых легитимных попаданий (0.856+ в форензике).
 */
export const SKILL_HINT_MIN_RAW_COS = 0.86;

/**
 * Причина НЕ подсказывать recall'нутый навык (null — подсказка уместна). Реплей-гейт не трогаем: у него свои
 * пороги, и recall как таковой (для реплея и учёта исхода) остаётся — режется только блок в промпте.
 */
export function skillHintBlockReason(s: RecalledSkill, text: string, conversational?: boolean): string | null {
  if (conversational) return "разговорный ход — процедура-навык в промпт не идёт";
  if (!hasCommandVerb(text)) return "в реплике нет командного глагола";
  const raw = s.recallSimRaw ?? s.recallSim;
  if (raw === undefined) return "лексический recall без семантической уверенности";
  if (raw < SKILL_HINT_MIN_RAW_COS) return `сырой косинус ${raw.toFixed(3)} < ${SKILL_HINT_MIN_RAW_COS}`;
  return null;
}

/**
 * `gate.conversational` — разговорный ход (вопрос/реакция): навык не подсказываем. Необязателен — без него
 * работают гейты по тексту и порогу (проводку из loop/context.ts добавляет интегратор, см. notes ревью).
 */
export async function retrieveContext(deps: AgentDeps, text: string, sink: ReplySink | undefined, gate?: { conversational?: boolean }) {
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
  // Б6: recall навыка на разговорном ходе оставлен (дешёвый e5), но с ревью 2026-09-24 (T-F2) его ПОДСКАЗКА
  // в промпт на разговорном ходе/реплике без команды/шумном косинусе не идёт — см. skillHintBlockReason.
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
  const [facts, found, catalog] = await Promise.all([factsP, recallP, catalogP]);
  // Своя копия на ход: метка «без подсказки» — по идентичности объекта, кеш провайдера её не унаследует.
  const recalled = found ? { ...found } : null;
  const hintBlocked = recalled ? skillHintBlockReason(recalled, text, gate?.conversational) : null;
  if (recalled && hintBlocked) {
    suppressSkillHint(recalled);
    log.info("recall навыка (§8): подсказка в промпт НЕ идёт (T-F2)", { id: recalled.id, reason: hintBlocked });
  } else if (recalled) log.info("recall навыка (§8)", { id: recalled.id, version: recalled.version });
  // Каталог — при промахе recall ИЛИ когда подсказку не дали: модель видит навыки по именам и решает сама.
  const skillCatalog = !recalled || hintBlocked ? formatSkillCatalog(catalog) : "";
  return { facts, recalled, skillCatalog };
}
