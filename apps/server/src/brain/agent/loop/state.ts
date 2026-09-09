// W3 «Петля»: типизированное состояние одного прогона runAgentLoop вместо ~90 замыканных флагов.
// Группы: tier (модель/эскалация), exit (как закончились), budget (время/контекст), honesty (что реально
// сделано — гейты §14/вуаль/verify-долг), nudge (счётчики подсказок модели), progress (ход задачи),
// usage (токены/деньги), arsenal (набор инструментов, пересобирается tool_load). Комментарии у полей —
// перенесены от прежних объявлений в петле дословно: они и есть спецификация поведения.
import type { Tier } from "@jarvis/shared";
import type { ToolSchema } from "@jarvis/tools";
import type { GestureEvent } from "../../../memory/skill-macro.js";

export interface TierState {
  // Тир можно ПОВЫСИТЬ прямо в петле, если модель застревает (§7, принцип «не сдаваться»):
  // haiku → sonnet → fable. Так слабая модель не упирается, а заходит сильнее.
  currentTier: Exclude<Tier, "tier0">;
  model: string;
  /**
   * Модель, которая РЕАЛЬНО отвечала (последний раунд). На резерве-подписке она своя (Opus 5) и с
   * моделью тира не совпадает — а метрики/лог писали именно тир, и на вопрос владельца «там точно
   * Opus 5?» ответить по логу было НЕЛЬЗЯ (2026-09-02). Пусто до первого ответа.
   */
  modelUsedLast: string | undefined;
  /** Каким каналом шёл последний раунд — в метрику задачи (разрез «быстрота/цена по каналу»). */
  lastChannelUsed: "api" | "subscription" | undefined;
  // Волна 1 (1.8): пер-раундовая диагностика кеша — модель прошлого раунда и был ли prune скринов
  // (обе — типовые причины перезаписи префикса; см. WARN «перезапись префикса» ниже).
  prevRoundModel: string;
  // §скорость: усиление family-нуджа ОДНОРАЗОВОЕ — раунд переосмысления идёт на сильной модели,
  // затем возвращаемся на прежний тир. Раньше эскалация была липкой, и вся оставшаяся МЕХАНИКА
  // задачи (клики/скрины по навыку) ехала на Opus в 2–3 раза медленнее по времени раунда (живой
  // замер «поиск в доте»: ~15с/раунд). Новые провалы после отката снова эскалируют штатно (§7).
  familyBoost: { tier: Exclude<Tier, "tier0">; model: string; roundsLeft: number } | null;
  // §Волна2 (2.7) пер-раундовый thinking: nudgeBoostNextRound — следующий раунд идёт сразу после
  // нуджа/эскалации/поправки (переосмысление → полное рассуждение); prevThinkingOn — с каким thinking
  // сгенерирован ПРОШЛЫЙ раунд (off→on легально только на текстовой границе — см. thinking-policy).
  // Выключатель всей механики: JARVIS_ROUND_THINKING=0 (всегда базовый эффорт тира, как раньше).
  nudgeBoostNextRound: boolean;
  prevThinkingOn: boolean;
  escalatedFrom: { tier: Exclude<Tier, "tier0">; model: string } | null;
  strongLocked: boolean;
  executorReverted: boolean;
  cleanRoundsStreak: number;
  // подряд провальных раундов → эскалация тира (§7)
  consecErrorRounds: number;
}

export interface ExitState {
  cancelled: boolean;
  limited: boolean;
  // причина предохранителя (spend_cap → продуктовый текст квоты)
  limitedReason: string | undefined;
  timedOut: boolean;
  // подвид timedOut: свернулись ЗАРАНЕЕ (остаток < среднего раунда), потолок не превышен
  earlyWrap: boolean;
  contextWrap: boolean;
  // Б4 (г): канал ПК не вернулся за окно ожидания → задача честно прервана обрывом
  channelLost: boolean;
  // §Волна2 (2.5): admission-очередь не дождалась аренды ввода → честный провал БЕЗ единого LLM-раунда.
  queueTimedOut: boolean;
  failed: boolean;
  // H2 (ревью 2026-07-02): LLM ушёл в аварийный стаб (stopReason==="stub" — сеть/ретраи исчерпаны).
  // Это ПРОВАЛ хода, а не ответ: нельзя финалить задачу успехом и нельзя кэшировать стаб-текст.
  llmStubbed: boolean;
  // M5 (ревью 2026-07-04): если стаб УЖЕ отдан пользователю через sink (step0-стрим озвучил стаб-текст),
  // терминал НЕ должен писать в память/чат ДРУГОЙ текст, чем прозвучал вслух. Храним реально
  // произнесённый стаб-текст и переиспользуем его в терминале вместо подстановки чужой фразы.
  stubSpokenText: string;
  runawayStuck: boolean;
  /** Обрыв петли по флуду одним инструментом — ПРОВАЛ с собственной формулировкой (не успех). */
  floodStuck: boolean;
  /** Инструмент, на котором случился флуд (для честной фразы терминала — без эха преамбулы модели). */
  floodTool: string;
}

export interface BudgetState {
  // Защитный потолок времени задачи (§20): даже если шаг где-то завис мимо своих таймаутов,
  // петля не остаётся в «выполняю» навечно — финализируем (терминал → панель/чип закрывается).
  // env JARVIS_TASK_MAX_MS (деф 4 мин, кламп [30с, 30мин]). let: ensureInput сдвигает старт на время,
  // простоянное в очереди за арендой ввода (Волна 1 — очередь не сжигает бюджет задачи).
  loopStartMs: number;
  // суммарное ожидание аренды (телеметрия; в потолок/latency не входит)
  queueWaitMs: number;
  // fix 2026-07-15 (ревью #5): суммарное БЛОКИРУЮЩЕЕ ОЖИДАНИЕ внутри вызовов (wait_for browser поллит DOM
  // до met/таймаута). Как queueWaitMs — НЕ тикает в потолок задачи и вычитается из avgRoundMs, иначе долгое
  // ожидание раздувало avgRoundMs → early-wrap срубал задачу ДО действия после ожидания («жди→перемотай»).
  idleWaitMs: number;
  // ожидание ПОСЛЕДНЕГО успешного acquire (для гарда протухшего клика)
  lastAcquireWaitMs: number;
  // сколько слепых действий уже заблокировал гард (кэп 2 — анти-deadloop)
  staleGuardBlocks: number;
  // суммарная длительность завершённых раундов (для гарда «остаток < среднего раунда»)
  roundDurTotalMs: number;
  // Волна 1 (1.5, «видимый бюджет»): на 70% потолка времени — ОДИН впрыск «сворачивайся» (graceful
  // wrap-up c честным частичным итогом вместо невидимого обрыва «251с работы → „затянулось" без итога»).
  budgetNudged: boolean;
  // Гард контекст-окна (см. CONTEXT_SOFT/HARD_TOKENS): одноразовый нудж на soft-пороге + подвид timedOut
  // (contextWrap) на hard-пороге — честный частичный итог вместо жёсткого 400 на середине задачи.
  contextNudged: boolean;
  // Волна E: на 70%-нудже лёг страховочный снимок чекпойнта (переживает ТОЛЬКО жёсткий kill —
  // штатный выход из петли гасит его в finally, терминалы прерывания пишут поверх свою версию).
  preventiveCheckpoint: boolean;
  // размер ПОСЛЕДНЕГО отправленного промпта (input+cache_read+cache_creation)
  lastPromptTokens: number;
  // Аудит контекста 2026-07-20 (PROACTIVE-гард): оценка токенов tool_result'ов ТЕКУЩЕГО раунда, которые
  // попадут в СЛЕДУЮЩИЙ промпт, но ещё НЕ учтены в lastPromptTokens (тот — из usage прошлого ответа, до
  // добавления результатов). Раньше гард сверял ТОЛЬКО lastPromptTokens прошлого раунда → один раунд с
  // параллельными web_fetch/browser_read (по ~8000 симв) + screen_capture мог внести прирост больше
  // headroom и пробить жёсткие ~200K (HTTP 400) РАНЬШЕ, чем гард увидит размер. Проекция закрывает окно.
  pendingResultTokens: number;
  // Б3 (MEMORY_CONTEXT_REVIEW): в ДЛИННОЙ задаче системный снимок промпта заморожен на момент старта —
  // окна/вкладки/часы врут через минуты работы, и модель платит screen_capture (~2K ток) за то, что
  // приезжает бесплатно каждые 12с (client.system обновляет deps.userContext.systemContext ЖИВЬЁМ).
  // Впрыскиваем свежий снимок ХВОСТОМ convo (не пересобирая system-блок — иначе инвалидировались бы
  // rolling-брейкпоинты, класс Д5), только когда он РЕАЛЬНО изменился и только после нескольких раундов.
  lastLiveCtx: string;
  // §режим выделения: КЛЮЧ выделения, о котором петля знает (адверс-ревью 2026-09-05: сравнение
  // отрендеренной строки с тикающим возрастом давало «выделение изменилось» КАЖДЫЙ раунд).
  lastSelectionKey: string;
  // троттл Б3 (#2): не чаще LIVE_REFRESH_EVERY раундов между впрысками
  lastLiveRefreshRound: number;
  // кап числа впрысков за задачу (#3: НЕ прунить старые — это ломало бы кеш Д5)
  liveRefreshCount: number;
  prunedLastRound: boolean;
  // Волна C: свёртка наблюдений — ОТДЕЛЬНАЯ причина перезаписи префикса. Смешивать её с prune скринов
  // нельзя: она режет десятки тысяч символов (дороже) и случается на задачах БЕЗ единой картинки —
  // форензика стоимости показывала бы «pruned-images» там, где скринов не было вовсе.
  maskedLastRound: boolean;
}

export interface HonestyState {
  /**
   * Хотя бы одно действие НЕ ВЫПОЛНЕНО, потому что не дали ресурс (аренда физического ввода не
   * освободилась за таймаут). 🔴 Разбор эпизода «Дота» 2026-09-02: ход, вслух сказавший владельцу
   * «Задача не выполнена», уходил в реестр как `state:"done"` и в метрики как `ok:true` — отказ
   * инструмента кладётся обычным `is_error`-блоком, а `failed` взводится только на исключении петли.
   * Врала телеметрия, а не модель; на ней же стоит самодиагностика (`self/weaknesses.ts` считает
   * провалы по `ok === false`) и гейт самообучения — то есть провальная траектория могла осесть
   * навыком. Признак СТРУКТУРНЫЙ: по тексту ответа не судим (терминал провала не переиспользует
   * текст модели — контроль-6 волны C).
   */
  inputDenied: boolean;
  /**
   * §режим выделения (контроль-3): хотя бы один вызов за задачу лёг об ВУАЛЬ оверлея (overlayDenied).
   * Зеркало inputDenied: «вуаль не дала и ничего не сделано» — не успех (реестр, самодиагностика,
   * навыку — не «успех», журнал чекпойнта не гасим). Сбрасывается правкой цели на ходу, как inputDenied.
   */
  overlayDeniedAny: boolean;
  /** Контроль-5 (V4-2): сколько шагов ПОСЛЕДНЕГО навыка/берста/макроса исполнено до остановки вуалью. */
  overlayPartialSteps: number;
  /** Контроль-6 (C5R-6): сумма исполненных шагов по ВСЕМ остановленным вуалью процедурам задачи (терминал называет её). */
  overlayPartialTotal: number;
  /** Контроль-6 (C5R-4): частично исполненные вызовы — для журнала чекпойнта (не «ОШИБКА», а «ЧАСТИЧНО — шаги 1..k»). */
  partialCalls: Map<string, { k: number; injected: boolean }>;
  /**
   * Контроль-8 (job-status-double-count): исполненные шаги — по ИСТОЧНИКУ, а не по вызову. `job_status` — ИДЕМПОТЕНТНЫЙ
   * отчёт об одном и том же задании: накопление `+=` превращало 2 реально сделанных клика в «всего исполнено 6» после
   * трёх опросов, и владельцу называли втрое больше необратимых действий, чем было. Берст/навык, наоборот, каждым
   * вызовом исполняет НОВЫЕ шаги — у них ключ свой на вызов.
   */
  partialBySource: Map<string, number>;
  /** Контроль-8 (background-job-no-success): jobId → tool_use id ЗАПУСКА: подтверждённое завершение снимает его неопределённость. */
  jobLaunchCalls: Map<string, string>;
  /**
   * Контроль-8 (verified-after-veil-rearm): вуаль отвергла МУТАЦИЮ, и НИЧЕГО не ушло. Чистый взгляд после такого отказа
   * не «удостоверяет» ход: сверять нечего — действие не состоялось. Без этого первый же чистый ui_snapshot снимал
   * фикс контроля-7 и пускал «Готово» в done при невыполненном клике.
   */
  veilDeniedNothingDone: boolean;
  /** Контроль-8 (durable-neutral-masked): в ходе ВООБЩЕ пробовали мутирующий инструмент (успешно или нет). */
  anyMutateAttempted: boolean;
  /** Контроль-6 (SR-C6-2): после ушедшего под вуалью действия модель СВЕРИЛА исход чистым взглядом — дальше судит её текст. */
  verifiedAfterVeil: boolean;
  /** Контроль-6 (C5R-5): сделано durable-дело нейтральным инструментом (память/напоминание/навык) — «посмотреть не смог» не обнуляет его. */
  anyDurableNeutralSucceeded: boolean;
  /** Контроль-5 (S1): действие остановленного шага уже ушло в GUI — исход неизвестен, повтор = дубль. */
  overlayActionInjected: boolean;
  /** Контроль-5 (V4-1): ход остановила ВУАЛЬ (взгляд/ожидание под ней), закрыт честным «не могу — жду» без единого дела. */
  veilGaveUp: boolean;
  // Был ли хоть один НЕошибочный инструмент: finalText ставится и когда модель сдалась после
  // сплошных ошибок (is_error в результатах не бросает исключение) — это НЕ успех, навык не
  // сохраняем (иначе recall впредь подсунул бы «приём» из проваленной задачи).
  anyToolSucceeded: boolean;
  // P0.1: успех ИМЕННО меняющего действия (toolEffect==="mutate"). Нейтральные (web_search/memory/
  // skill_*) НЕ считаются «дело сделано» — иначе «погуглил и сдался словами» проходит как успех, а
  // ложное «Готово» после одного поиска не ловится. Гейтим анти-капитуляцию и masked-failure по нему,
  // а anyToolSucceeded оставляем для self-learn/трейдинга (там важен ЛЮБОЙ успешный инструмент).
  anyMutateSucceeded: boolean;
  // Висит ли НЕсверённое слепое действие: ставится при успешном слепом mutate, снимается сверкой глазами.
  blindMutatePending: boolean;
  // §P1-отправка (форензика 2026-07-14, ложный успех «ушло в Клод»): был ли в задаче НАБРАН текст
  // (input_type / ui_invoke setValue / вставка), который следующий Enter/Ctrl+Enter КОММИТИТ.
  composedPending: boolean;
  // Долг сверки ИСХОДА отправки (ревью р1 #3/#4/#8/#9/#16): взводится КОММИТОМ (send-key после набора,
  // или берст compose→send). Снимается ТОЛЬКО реальным взглядом (eff==="verify": screen_capture/
  // ui_snapshot/browser_read/screen_read_text) — fused-наблюдение самого коммита ИЛИ соседнего жеста
  // (второй Enter, клик, фокус) его НЕ снимает: снимок «сразу после нажатия» показывает факт нажатия,
  // а не доставку. Это строже blindMutatePending (тот fused observed гасит).
  sendCommitDebt: boolean;
  /** tool_use_id отправок ЧЕЛОВЕКУ, по которым отправка ПОДТВЕРЖДЕНА (`ToolResult.sent`) — для журнала. */
  confirmedSends: Set<string>;
  /**
   * 🔴 Контроль-2 Ф0: вызовы, которые §14-гейт НЕ ПРОПУСТИЛ. Нужен ЖУРНАЛУ чекпойнта — иначе он
   * пишет им «ok» в несокращаемой секции «СДЕЛАНО», и «доделай» пропускает невыполненное действие,
   * рапортуя успех. Зеркало confirmedSends: сигнал честности обязан дойти до ОБОИХ потребителей.
   */
  declinedCalls: Set<string>;
  /**
   * 2026-08-31: вызовы с НЕИЗВЕСТНЫМ исходом (`ToolResult.uncertain`) — действие могло совершиться,
   * подтвердить не удалось. Журналу это нужно отдельно от «ОШИБКА»: иначе продолжение прочитает
   * «не сделано» и повторит необратимое (дубль живому человеку).
   */
  uncertainCalls: Set<string>;
  /** Контроль-2 Ф0: в ЭТОМ раунде действие остановил §14-гейт (отказ/нет ответа/не смогли спросить). */
  gateStoppedRound: boolean;
  /** Контроль-5: остановка была именно ВУАЛЬЮ (не §14-гейтом) — честный give-up после неё = провал по вуали, не done. */
  gateStoppedByVeil: boolean;
  lastRoundHadVerify: boolean;
  // §адаптация к цели: одноразовая сверка терминала с ИСХОДНОЙ задачей — ловит «выполнил подцель
  // (запустил приложение) и посчитал задачу сделанной» (живой случай: «запусти поиск в доте» →
  // «Дота запущена, сэр» без поиска). Кап 1 — не раздуваем задачу. Если ПОСЛЕДНИЙ инструментальный
  // раунд уже был сверкой глазами (screen_capture/read) — модель только что смотрела на результат,
  // лишний раунд не жжём (lastRoundHadVerify).
  goalCheckDone: boolean;
}

export interface NudgeState {
  // Анти-капитуляция (§«не сдавайся»): если модель закрыла ход текстом-отказом, НЕ вызвав НИ ОДНОГО
  // инструмента, один раз форсим попытку (web_search/code_run), вместо принятия «не умею» как финала.
  retryNudges: number;
  // VERIFY-ПЕТЛЯ (анти-конфабуляция «врёт готово» + анти-«сдался не проверив», P0.2): после СЛЕПОГО
  // меняющего действия (клик/ввод/act-в-странице/фокус — ok ≠ цель достигнута) и ДО того, как модель
  // закроет ход, ОБЯЗАТЕЛЬНА сверка глазами (browser_read/inspect/screen_capture). Раньше триггер
  // требовал ещё regex-claim о содержимом → «Готово, музыка играет» (без слов-маркеров) проходил без
  // сверки. Теперь триггер СТРУКТУРНЫЙ: blindMutatePending. Самоподтверждающиеся mutate (code_run/fs/
  // office/system/launch/open) сверки НЕ требуют (их исход уже в tool_result) — см. isBlindMutate.
  verifyNudges: number;
  // Пустой финал после инструментов (живой смоук 2026-07-02): модель «отдаёт ответ» в преамбуле
  // tool-раунда (она отбрасывается по дизайну §10) и закрывает ход пустым текстом → подставлялось
  // «Готово.» → на вопросе masked-failure превращал это в ложное «Не вышло». Один нудж — потребовать
  // содержательную финальную реплику.
  emptyFinalNudged: boolean;
  // H4 (ревью 2026-07-02): повтор ТОГО ЖЕ успешного действия — признак НЕдостигнутой цели (жмёт play
  // в пустоту), а прежний обрыв с дефолтом «Готово, сэр.» был ложным успехом в обход verify-петли.
  // Теперь: один интервент-нудж (сверь глазами / смени подход), при упорстве — честный провал.
  repeatNudged: boolean;
  familyNudges: number;
  // Мягкий anti-runaway по СЕМЕЙСТВУ: модель долбит ОДИН инструмент (web_act/browser_act/inspect…) много раз
  // с чуть РАЗНЫМ input — identicalRepeats (байт-в-байт) это НЕ ловит, и она флудит до max_steps (жалоба
  // «дублирует команды»). Считаем вызовы по ИМЕНИ за задачу: на пороге — интервент-нудж «смени подход» +
  // эскалация на Opus; упорствует дальше — честный обрыв. env JARVIS_TOOL_FAMILY_CAP.
  toolNameCount: Map<string, number>;
  // §3.9: file_view по РАЗНЫМ страницам/файлам — легитимная серия, а не флуд (ревью 2026-09-01: на 6-й странице
  // отчёта модель получала «топтание» + Opus, на 12-й — ложный «Застрял на file_view»). Повтором считается
  // только та же пара (path, page).
  seenFileViews: Set<string>;
  // Anti-runaway (§20): сигнатура tool-вызовов прошлого раунда + счётчик одинаковых подряд.
  // Модель иногда зацикливается на ОДНОМ И ТОМ ЖЕ УСПЕШНОМ действии (открывает «до посинения»,
  // карточка задачи не закрывается) — ловим повтор и обрываем. Только УСПЕШНЫЙ повтор: подряд
  // ПАДАЮЩИЕ инструменты — это путь эскалации тира (§7), их не трогаем.
  lastToolSig: string;
  identicalRepeats: number;
  // Докрутка обрыва по лимиту вывода: модель не закончила (stop_reason=max_tokens) → продолжаем
  // генерацию с места обрыва, а не отдаём огрызок (большой код/реферат/курсовая). Кап продолжений
  // + общие потолки задачи (токены/шаги/время) защищают от runaway. Env JARVIS_MAX_CONTINUATIONS.
  continuations: number;
  /** Подсказка про лестницу даётся ОДИН раз за задачу — это совет, а не гейт. */
  ladderHinted: boolean;
  /** Врезка отложена до конца раунда: внутри цикла tool_use её вставлять нельзя (см. ниже). */
  ladderHintPending: boolean;
  /** Смотрел ли уже структурой в этой задаче (иначе первый скриншот получит подсказку). */
  sawStructuralLook: boolean;
  /** Задача идёт в браузере — там структурный путь свой (browser_inspect), подсказка про UIA не нужна. */
  browserish: boolean;
}

export interface ProgressState {
  // число завершённых tool-use раундов (= прогресс задачи)
  round: number;
  /**
   * Волна C (контрольное ревью-2): раундов, чьи РЕЗУЛЬТАТЫ уже легли в convo. Инкрементируется СРАЗУ
   * после `convo.push(resultBlocks)`, в отличие от `round` (конец итерации) — обрыв канала/отмена
   * посреди раунда выходят из петли раньше инкремента, а мутации того раунда уже совершены. Гейт
   * чекпойнта по `round` терял их, и следующее «доделай» повторяло отправки людям.
   */
  committedToolRounds: number;
  // Ревью волны Б 2-й проход (#3): ФАКТИЧЕСКОЕ число итераций петли — растёт на КАЖДОЙ итерации, вкл.
  // continue (channel-down/нудж), в отличие от round (только завершённые tool-раунды). capExhausted
  // должен ловить истинное исчерпание HARD_STEP_CAP, а не round (тот отстаёт → ложное «Готово»).
  loopIters: number;
  finalText: string;
  // #5: последний непустой ответ модели (нудж мог обнулить finalText для переспроса)
  lastAnswer: string;
  // §10 realtime: финальная (конверсационная) реплика уже отдана в sink пофразно на 1-м ходе
  // (без tool_use) → терминал не дублирует её. На tool-ходах остаётся false → финал стримится
  // в конце целиком (пофразно). Стримим ТОЛЬКО 1-й ход: tool-результаты не произносим.
  streamedFinal: boolean;
  // §10: уже произнесли пользователю хоть фразу (стрим преамбулы/ответа)? Тогда в сбойном терминале
  // НЕ говорим противоречивое «не смог» — иначе после куска ответа звучит «не смог выполнить».
  spokeAny: boolean;
  // Прогресс показываем (панель + кнопка «стоп» в renderer) только когда задача реально
  // многошаговая (пошёл tool-use) — чтобы не мигать панелью на простых ответах (§20).
  shown: boolean;
  holdsInput: boolean;
  /**
   * 🔴 ШТОРМ ПАРАЛЛЕЛЬНОСТИ (лог 2026-09-02, вечер: шесть задач разом при потолке в три). Потолок
   * `MAX_PARALLEL_TASKS` держит семафор, и action-путь (`runActionSyncFirst`) слот берёт — а
   * РАЗГОВОРНЫЙ ход не берёт НИКОГДА, хотя с инструментами он идёт минутами (в логе: «вопрос —
   * разговор», 6 раундов, 127 секунд). Значит семафор ВРАЛ о занятости: следующая команда видела
   * свободный слот и стартовала поверх. Берём слот ЛЕНИВО (на первом же tool-раунде) и
   * НЕБЛОКИРУЮЩЕ (`tryAcquire`): сам вопрос не тормозим, но занятость становится правдой, и
   * очередная команда честно уходит в bounded-фон вместо перегруза.
   */
  convoSlotHeld: boolean;
  // §8 HERMES: траектория инструментов (для нуджа самообучения) + флаг «навык уже сохранён
  // в этой задаче» (модель вызвала skill_save сама) → не нуждить повторно после петли.
  toolTrajectory: string[];
  skillSavedInLoop: boolean;
  // §8 МАКРОС: id навыка, сохранённого В ЭТОЙ задаче (skill_save в петле или self-learn после) —
  // адресат дозаписи авто-реплея жестов (generic: любое UIA-слепое приложение, не только recall-путь).
  savedSkillId: string | null;
  // §8: задача потребовала самостоятельного research (web_search/web_fetch) — «не знал как, нашёл сам».
  // Такой приём ценно сохранить навыком даже на короткой траектории (иначе каждый раз гуглим заново).
  wasResearched: boolean;
  // §20 чип «по смыслу»: заголовок задачи ставим из ПЕРВОГО значимого действия (а не из сырой
  // фразы STT). Ставится один раз — дальше не дёргаем, чтобы чип не прыгал.
  semanticTitleSet: boolean;
  // §8 МАКРОС: трасса ЖЕСТОВ успешных GUI-инструментов (фокус/клики/клавиши) — после успеха задачи
  // механически компилируется в реплей-шаги навыка (skill-macro.ts), чтобы в следующий раз
  // исполниться детерминированно за секунды, без LLM-раундов.
  gestureTrace: GestureEvent[];
  /**
   * Волна C (контрольное ревью-2): тексты, которые ПЕТЛЯ впрыснула в user-роль (нуджи бюджета/
   * контекста/verify/goal-check, докрутка max_tokens, live-снимок ПК, итог авто-макроса). В журнал
   * продолжения они попадать НЕ должны — иначе Джарвис приписывает владельцу выдуманные приказы, а
   * возобновлённый заход читает протухшее «сворачивайся, осталось 30с» как свежее указание.
   * Поправка на ходу (steer) сюда НЕ добавляется: она цитирует владельца и в журнале нужна.
   */
  systemNotes: Set<string>;
  ackTimer: NodeJS.Timeout | undefined;
}

export interface UsageState {
  // метрики prompt-кеша за задачу (§15)
  cacheReadTokens: number;
  cacheCreationTokens: number;
  // Телеметрия (obs/metrics): копим токены/вызовы за всю задачу для per-task события.
  inputTokensTotal: number;
  outputTokensTotal: number;
  toolCallsTotal: number;
  // Фактически НАЧИСЛЕННЫЕ деньги задачи: ход по подписке оплачен помесячно и стоит $0 (см. ниже), а
  // пересчёт по прайсу модели завышал /cogs и metrics.jsonl в разы — дашборд юнит-экономики врал владельцу
  // ровно там, где по нему считают цену продукта (живой прогон 2026-09-02).
  taskChargedUsd: number;
}

export interface ArsenalState {
  tools: ToolSchema[];
  systemTools: string | undefined;
}

export interface LoopInit { tier: Exclude<Tier, "tier0">; model: string }

export interface LoopState {
  tier: TierState;
  exit: ExitState;
  budget: BudgetState;
  honesty: HonestyState;
  nudge: NudgeState;
  progress: ProgressState;
  usage: UsageState;
  arsenal: ArsenalState;
}

function initTierState(init: LoopInit): TierState {
  return {
    currentTier: init.tier,
    model: init.model,
    modelUsedLast: undefined,
    lastChannelUsed: undefined,
    prevRoundModel: init.model,
    familyBoost: null,
    nudgeBoostNextRound: false,
    prevThinkingOn: false,
    escalatedFrom: null,
    strongLocked: false,
    executorReverted: false,
    cleanRoundsStreak: 0,
    consecErrorRounds: 0,
  };
}

function initExitState(): ExitState {
  return {
    cancelled: false,
    limited: false,
    limitedReason: undefined,
    timedOut: false,
    earlyWrap: false,
    contextWrap: false,
    channelLost: false,
    queueTimedOut: false,
    failed: false,
    llmStubbed: false,
    stubSpokenText: "",
    runawayStuck: false,
    floodStuck: false,
    floodTool: "",
  };
}

function initBudgetState(): BudgetState {
  return {
    loopStartMs: 0,
    queueWaitMs: 0,
    idleWaitMs: 0,
    lastAcquireWaitMs: 0,
    staleGuardBlocks: 0,
    roundDurTotalMs: 0,
    budgetNudged: false,
    contextNudged: false,
    preventiveCheckpoint: false,
    lastPromptTokens: 0,
    pendingResultTokens: 0,
    lastLiveCtx: "",
    lastSelectionKey: "",
    lastLiveRefreshRound: -100,
    liveRefreshCount: 0,
    prunedLastRound: false,
    maskedLastRound: false,
  };
}

function initHonestyState(): HonestyState {
  return {
    inputDenied: false,
    overlayDeniedAny: false,
    overlayPartialSteps: 0,
    overlayPartialTotal: 0,
    partialCalls: new Map<string, { k: number; injected: boolean }>(),
    partialBySource: new Map<string, number>(),
    jobLaunchCalls: new Map<string, string>(),
    veilDeniedNothingDone: false,
    anyMutateAttempted: false,
    verifiedAfterVeil: false,
    anyDurableNeutralSucceeded: false,
    overlayActionInjected: false,
    veilGaveUp: false,
    anyToolSucceeded: false,
    anyMutateSucceeded: false,
    blindMutatePending: false,
    composedPending: false,
    sendCommitDebt: false,
    confirmedSends: new Set<string>(),
    declinedCalls: new Set<string>(),
    uncertainCalls: new Set<string>(),
    gateStoppedRound: false,
    gateStoppedByVeil: false,
    lastRoundHadVerify: false,
    goalCheckDone: false,
  };
}

function initNudgeState(): NudgeState {
  return {
    retryNudges: 0,
    verifyNudges: 0,
    emptyFinalNudged: false,
    repeatNudged: false,
    familyNudges: 0,
    toolNameCount: new Map<string, number>(),
    seenFileViews: new Set<string>(),
    lastToolSig: "",
    identicalRepeats: 0,
    continuations: 0,
    ladderHinted: false,
    ladderHintPending: false,
    sawStructuralLook: false,
    browserish: false,
  };
}

function initProgressState(): ProgressState {
  return {
    round: 0,
    committedToolRounds: 0,
    loopIters: 0,
    finalText: "",
    lastAnswer: "",
    streamedFinal: false,
    spokeAny: false,
    shown: false,
    holdsInput: false,
    convoSlotHeld: false,
    toolTrajectory: [],
    skillSavedInLoop: false,
    savedSkillId: null,
    wasResearched: false,
    semanticTitleSet: false,
    gestureTrace: [],
    systemNotes: new Set<string>(),
    ackTimer: undefined,
  };
}

function initUsageState(): UsageState {
  return {
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    toolCallsTotal: 0,
    taskChargedUsd: 0,
  };
}

function initArsenalState(): ArsenalState {
  return {
    tools: [],
    systemTools: undefined,
  };
}

export function createLoopState(init: LoopInit): LoopState {
  return {
    tier: initTierState(init),
    exit: initExitState(),
    budget: initBudgetState(),
    honesty: initHonestyState(),
    nudge: initNudgeState(),
    progress: initProgressState(),
    usage: initUsageState(),
    arsenal: initArsenalState(),
  };
}

// Пояснение к HonestyState.verifiedAfterVeil (перенесено из петли дословно):
/**
 * 🔴 Контроль-10 (veil-verify-order-rearms-c8): контроль-9 заменил этот липкий признак сравнением НОМЕРОВ РАУНДОВ —
 * и тем откатил фикс контроля-8. `verifiedAfterVeil` и так обнуляется на КАЖДОМ новом отказе, поэтому «сверка позже
 * отказа» истинна всегда, кроме случая «отказ и сверка в одном раунде»: различалась не суть, а ГРУППИРОВКА вызовов
 * моделью. Полое «Готово» после отказанного НОВОГО клика снова уезжало в done с ok:true.
 *
 * Признак вернулся липким, но настоящая боль контроля-9 закрыта ИНАЧЕ и честнее: сверенное УШЕДШЕЕ действие
 * (`injectedVerified`) больше не отрицается в терминале — там, где раньше владельцу говорили «нужное действие я не
 * сделал» про отправленное сообщение, теперь называются ОБА факта: что ушло и сверено, и что вуаль не дала сделать.
 * Судить «повтор это был или новое дело» петля не может и не пытается: отказанная мутация, которой не было, — не успех.
 */
