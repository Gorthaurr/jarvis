/**
 * ПАСПОРТ ВОЗМОЖНОСТЕЙ (волна E, идея Skales «Live Capability Registry»): маленький ЧЕСТНЫЙ снимок
 * «что реально доступно ПРЯМО СЕЙЧАС» для НЕкешируемого хвоста промпта. Цель — честность ДО провала:
 * модель заранее говорит «расширение не подключено, сэр — перезагрузите его в chrome://extensions»,
 * а не проваливает browser_act в рантайме и не обещает канал, которого нет.
 *
 * Принципы:
 *  - Снимок собирается НА КАЖДЫЙ ход из живых объектов ($0, O(1)) — «пересборка по событиям» не
 *    нужна, состояние читается в момент сборки промпта; хвост и так меняется каждый ход (кеш §15 цел).
 *  - Пишем ТОЛЬКО достоверное серверу: расширение (live-флаг WS), MCP (state коннекта), наличие
 *    КЛЮЧЕЙ (env). «Ключ есть» ≠ «канал жив» — формулировки это различают (закон честности).
 *  - Капнут по размеру (какой бы список MCP ни вырос) — паспорт не должен разъедать окно.
 */
export interface CapabilityInput {
  /** WS расширения Chrome жив прямо сейчас. */
  extensionConnected: boolean;
  /** MCP-серверы: server/state/tools из McpManager.status(). */
  mcpServers: ReadonlyArray<{ server: string; state: string; tools: number }>;
  /** Ключ Brave-поиска задан (иначе keyless DuckDuckGo — поиск работает всегда). */
  braveKey: boolean;
  /** Токен Тинькофф Инвест задан (tinkoff_portfolio/market tinkoff). */
  tinkoffToken: boolean;
  /** OBS obs-websocket сконфигурирован (host/password в env). */
  obsConfigured: boolean;
  /** Killswitch: причина остановки автономии, null = работает. */
  autonomyFrozenReason: string | null;
  /**
   * Резервный канал на подписке: последняя причина отказа (undefined — отказов не было).
   * Живой случай 2026-08-31: OAuth-сессия протухла, канал молча отдавал стаб «связь прервалась» —
   * владелец не мог узнать, что достаточно заново авторизоваться. Знание причины — на КАЖДЫЙ ход.
   */
  subscriptionFailure?: { kind: string; human: string };
}

const MAX_CHARS = 1100;
/** Кап на ПЕРЕЧЕНЬ серверов (контроль-ревью: глобальный slice с хвоста срезал бы критичные строки). */
const MAX_LIST = 6;

function capList(names: string[]): string {
  if (names.length <= MAX_LIST) return names.join(", ");
  return `${names.slice(0, MAX_LIST).join(", ")} и ещё ${names.length - MAX_LIST}`;
}

export function renderCapabilityPassport(c: CapabilityInput): string {
  const lines: string[] = [
    "# Паспорт возможностей (живой снимок на этот ход — сверяйся, прежде чем обещать канал)",
  ];
  // Killswitch — ПЕРВОЙ содержательной строкой (контроль-ревью: усечение с хвоста не должно срезать
  // самый критичный факт; строки фиксированной длины идут до переменных списков).
  if (c.autonomyFrozenReason !== null) {
    lines.push(
      `- ⛔ АВТОНОМИЯ ОСТАНОВЛЕНА владельцем (killswitch: ${c.autonomyFrozenReason.slice(0, 120)}). Наблюдения/проактив/фоновые проверки заморожены; на «почему молчишь/не следишь» отвечай честно этим фактом и напомни команду «включи автономию».`,
    );
  } else {
    // Дискаверабельность (контроль-ревью): владелец может попросить «останови всё насовсем» своими
    // словами — модель должна знать про детерминированную команду, а не изобретать полумеры.
    lines.push("- Аварийный стоп ВСЕЙ автономии — детерминированная команда владельца: «полный стоп» (вернуть: «включи автономию»).");
  }
  // Резерв на подписке — сразу после killswitch: если он лёг, это объясняет ВСЕ последующие «связь
  // прервалась», и владельцу нужно назвать причину и лечение, а не общий сбой.
  if (c.subscriptionFailure) {
    lines.push(
      `- ⚠️ Резервный канал (подписка) не отвечает: ${c.subscriptionFailure.human.slice(0, 160)}. Если основной ключ тоже недоступен — честно скажи владельцу ЭТУ причину, не «связь прервалась».`,
    );
  }
  lines.push(
    c.extensionConnected
      ? "- Расширение Chrome: ПОДКЛЮЧЕНО (browser_open/act/read, telegram_*, calendar_read/mail_read доступны)."
      : // Контроль-2: telegram_send здесь НЕ объявляется недоступным — его ОСНОВНОЙ путь клиентский
        // CDP-Chrome, расширение лишь фолбэк (ложное «недоступно» — тоже нечестность).
        "- Расширение Chrome: НЕ ПОДКЛЮЧЕНО — browser_act/read/tabs и calendar/mail-чтение сейчас честно откажут (не обещай их; уместно предложить владельцу перезагрузить расширение в chrome://extensions). Просто ОТКРЫТЬ сайт можешь: browser_open уйдёт shell-фолбэком в дефолтный браузер, но без вкладочного tabId. telegram_* могут пройти основным CDP-путём клиента — сверяйся исходом инструмента.",
  );
  const up = c.mcpServers.filter((s) => s.state === "connected");
  const down = c.mcpServers.filter((s) => s.state !== "connected");
  if (up.length > 0) lines.push(`- MCP подключены: ${capList(up.map((s) => `${s.server} (${s.tools})`))}.`);
  if (down.length > 0) lines.push(`- MCP НЕ поднялись: ${capList(down.map((s) => s.server))} — их mcp__*-инструменты недоступны.`);
  lines.push(c.braveKey ? "- Веб-поиск: Brave (+DDG-фолбэк)." : "- Веб-поиск: keyless DuckDuckGo (Brave-ключа нет; поиск работает).");
  if (!c.tinkoffToken) lines.push("- Тинькофф: токена нет — tinkoff_portfolio и market «tinkoff» недоступны (не предлагай).");
  // OBS: env ЧУЖОГО процесса (актуатор живёт в клиенте и умеет дефолт ws://127.0.0.1:4455) — сервер
  // НЕ утверждает «недоступен» (контроль-ревью: ложное «недоступно» — тоже нечестность).
  if (!c.obsConfigured)
    lines.push("- OBS: ключей в env сервера нет — доступность НЕ проверена; при просьбе пробуй obs_request (откажет честно, если OBS не запущен).");
  const text = lines.join("\n");
  // Страховочный глобальный кап (после пер-списочных практически недостижим); усечение видно честно.
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
}
