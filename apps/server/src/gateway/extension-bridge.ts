/**
 * Мост к браузерному расширению «Jarvis Web Hands» (§6 — невидимые руки в браузере).
 *
 * Расширение живёт в Chrome пользователя (его профиль, его логины) и подключается сюда
 * по WS (/ext). Сервер шлёт интенты ({id, type, ...}); расширение исполняет их в фоновой
 * вкладке и отвечает {id, ok, data|error}. request() корреллирует ответ по id с таймаутом.
 *
 * Один процесс — один активный коннект расширения (на текущего пользователя). Декуплен от
 * Fastify минимальным интерфейсом ExtSocket — тестируется без сети.
 */
import { newId } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { extNoReplyError, extReplyError } from "../brain/tools/ext-errors.js";

/** Параметры снимка вкладки (контракт W1 §1): rect — CSS px вьюпорта; ref — элемент из снимка; scale — масштаб кропа. */
export interface TabCaptureOpts {
  rect?: { x: number; y: number; w: number; h: number };
  ref?: string;
  scale?: number;
}

/** Минимальный контракт сокета расширения (Fastify ws / мок в тестах). */
export interface ExtSocket {
  send(data: string): void;
  close(): void;
}

interface Pending {
  resolve(data: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class ExtensionBridge {
  private socket: ExtSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly log: Logger;

  constructor(log: Logger = createLogger("ext-bridge")) {
    this.log = log;
  }

  /** Подключено ли расширение сейчас. */
  get connected(): boolean {
    return this.socket !== null;
  }

  /** Привязать новый коннект расширения (вытесняет прежний). */
  attach(socket: ExtSocket): void {
    if (this.socket && this.socket !== socket) {
      // ВАЖНО: вытесняя старый сокет, отклоняем его ожидающие запросы СРАЗУ — иначе они
      // висят до таймаута на уже мёртвом коннекте (утечка/зависание).
      this.rejectAllPending("расширение переподключилось");
      try {
        this.socket.close();
      } catch {
        /* старый мёртв */
      }
    }
    this.socket = socket;
    this.log.info("расширение подключено (руки в браузере готовы)");
  }

  /** Отвязать коннект (по close). Незавершённые запросы — отклоняем. */
  detach(socket: ExtSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.rejectAllPending("расширение отключилось");
    this.log.info("расширение отключено");
  }

  /** Отклонить все ожидающие запросы (вытеснение/отключение). Запросы УЖЕ ушли — ответа нет, исход неизвестен (B-4). */
  private rejectAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(extNoReplyError(reason));
    }
    this.pending.clear();
  }

  /** Входящее сообщение от расширения: hello / ответ {id, ok, data|error}. */
  handleMessage(raw: string): void {
    let msg: { id?: string; type?: string; ok?: boolean; data?: unknown; error?: string; code?: unknown; label?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      this.log.info("расширение: hello");
      return;
    }
    if (!msg.id) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.data);
    // W1 (контракт §7): код отказа страницы/SW и подпись (commit_confirm) — в поля ошибки; сервер читает e.code.
    else p.reject(extReplyError(msg.error || "ошибка расширения", msg.code, msg.label));
  }

  /**
   * Отправить интент расширению и дождаться результата (с таймаутом). Если расширение
   * не подключено — сразу ошибка (вызывающий решает, что делать — напр., откат на UI-путь).
   */
  request(intent: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (!this.socket) return Promise.reject(new Error("расширение не подключено"));
    const id = newId();
    const socket = this.socket;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Запрос УЖЕ ушёл: расширение могло нажать и не успеть ответить — это «неизвестно», не «не вышло» (B-4).
        reject(extNoReplyError("расширение не ответило за " + timeoutMs + "мс"));
      }, timeoutMs);
      if (typeof timer === "object" && "unref" in timer) (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, ...intent }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Удобный шорткат: отправить сообщение в Telegram через расширение.
   *  variants — оригинал + транслит-варианты имени (recall, чтобы кросс-скриптовый контакт всплыл;
   *  решение, кто настоящий, остаётся за моделью — расширение вернёт кандидатов при неоднозначности). */
  telegramSend(to: string, text: string, variants?: string[]): Promise<unknown> {
    return this.request({ type: "telegram.send", to, text, variants: variants ?? [] }, 45_000);
  }

  /** Отправить ГОЛОСОВОЕ в Telegram (TTS mp3 base64 → запись голосом филиппа через подмену микрофона). */
  telegramSendVoice(to: string, audioB64: string): Promise<unknown> {
    return this.request({ type: "telegram.send_voice", to, audioB64 }, 90_000);
  }

  /** §проактив-всё: НЕПРОЧИТАННЫЕ Telegram-чаты из УЖЕ открытой вкладки (без кражи фокуса). Нет вкладки →
   *  {ok:true, noTab:true}. Для ambient-источника «вам написал X» — дёшево, неинвазивно, короткий таймаут. */
  telegramUnread(): Promise<unknown> {
    return this.request({ type: "telegram.unread" }, 8_000);
  }

  /** D-4: события календаря из вкладки владельца (БЕЗ OAuth). open=false — неинвазивно, только уже
   *  открытая вкладка (ambient); open=true — по явной просьбе можно открыть ФОНОВУЮ вкладку (дольше). */
  calendarRead(open = false): Promise<unknown> {
    return this.request({ type: "calendar.read", open }, open ? 40_000 : 8_000);
  }

  /** D-5: непрочитанные письма из вкладки владельца (БЕЗ OAuth). Только список (кто/тема), тело не читаем. */
  mailRead(open = false): Promise<unknown> {
    return this.request({ type: "mail.read", open }, open ? 40_000 : 8_000);
  }

  /**
   * Открыть URL в браузере пользователя С УЧЁТОМ открытых вкладок (§): есть вкладка сервиса →
   * фокус на неё, нет → новая. Решает «постоянно новые вкладки». Возвращает {focused|created}.
   * Не подключено расширение — reject (вызывающий откатится на shell-open).
   */
  openOrFocus(url: string): Promise<unknown> {
    return this.request({ type: "tab.openOrFocus", url }, 15_000);
  }

  /** Прочитать вкладку (по tabId из open / url-хосту / активную) в сессии пользователя. query —
   *  ключевые слова: фильтр строк текста (+ структура h1-h3 и текст iframe'ов в ответе). */
  tabRead(url?: string, tabId?: number, query?: string): Promise<unknown> {
    return this.request({ type: "tab.read", url: url ?? "", tabId, query: query ?? "" }, 15_000);
  }

  /** Список открытых вкладок (заголовок/URL/активна/звучит) — чтобы резолвить «какую вкладку». */
  tabList(): Promise<unknown> {
    return this.request({ type: "tab.list" }, 10_000);
  }

  /** §перенос логинов: выгрузить куки залогиненного Chrome пользователя (chrome.cookies — РАСШИФРОВАННЫЕ,
   *  минуя app-bound encryption) → для импорта в невидимый браузер Джарвиса. domains — фильтр хостов (опц.). */
  exportCookies(domains?: string[]): Promise<unknown> {
    return this.request({ type: "cookies.export", domains: domains ?? null }, 20_000);
  }

  /** Закрыть вкладку(и): по tabId (точно) / хосту url (все этого сайта) / активную. */
  tabClose(url?: string, tabId?: number): Promise<unknown> {
    return this.request({ type: "tab.close", url: url ?? "", tabId }, 10_000);
  }

  // W1: ref-режим — единственный (флаг JARVIS_BROWSER_REF удалён). `refMode:true` шлём ВСЕГДА — для старой версии
  // расширения (пока владелец не нажал «Обновить» в chrome://extensions); новое поле игнорирует.

  /** ГЛАЗА В DOM: снимок интерактивных элементов вкладки (ref у каждого, состояние, secret у секретных полей).
   *  query — ранжированный поиск (find): результаты дописываются в реестр ref, прежние ref живы. */
  tabInspect(url?: string, query?: string, cap?: number, tabId?: number): Promise<unknown> {
    return this.request({ type: "tab.inspect", url: url ?? "", query: query ?? "", cap, tabId, refMode: true }, 15_000);
  }

  /** Действие В вкладке пользователя (click/type/set/select/key/hover/scroll_to/play/…) через chrome.scripting. */
  tabAct(url: string, intent: string, params?: Record<string, unknown>, tabId?: number): Promise<unknown> {
    return this.request({ type: "tab.act", url, intent, params: params ?? {}, tabId, refMode: true }, 20_000);
  }

  /** §Волна2-веб: БЕРСТ шагов по ref/selector/text одним вызовом — многополевая форма за 1 раунд, стоп на первой ошибке. */
  tabBatch(url: string, steps: unknown[], tabId?: number): Promise<unknown> {
    return this.request({ type: "tab.batch", url, steps, tabId, refMode: true }, 60_000);
  }

  /** W1: снимок ВИДИМОЙ области активной вкладки (или кроп rect/ref). Не активна → {ok:false, code:"tab_not_visible"}. */
  tabCapture(url: string, tabId: number | undefined, opts: TabCaptureOpts = {}): Promise<unknown> {
    return this.request({ type: "tab.capture", url, tabId, ...opts }, 15_000);
  }
}
