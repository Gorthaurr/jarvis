/**
 * Браузер через Chrome DevTools Protocol (§6, §12).
 *
 * Минимальный CDP-клиент на встроенных fetch + WebSocket (Node 22) — БЕЗ puppeteer-
 * зависимости (в духе кодовой базы: свой Deepgram-WS и т.п.). Драйвит ВЫДЕЛЕННЫЙ
 * Chrome-инстанс (свой профиль, отдельный от основного сеанса пользователя), запущенный
 * с --remote-debugging-port. За интерфейсом BrowserController — позже сюда же встанет
 * hak-browser (anti-detect) без изменения вызовов.
 *
 * Анти-инъекция: интент и параметры в eval-скрипты идут JSON-ЛИТЕРАЛАМИ (чистые данные),
 * а не конкатенацией в код. Скелет скрипта фиксирован.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import NodeWebSocket from "ws";
import { createLogger } from "@jarvis/shared";
import { resolveAutomationBrowser } from "../sensors/system-profiler.js";
import { monitors } from "../monitors.js";

/** Свободный TCP-порт от ОС (исключает коллизии и подключение к чужому debug-инстансу). */
function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("не удалось получить свободный порт"))));
    });
  });
}

const log = createLogger("actuator:browser-cdp");

export interface PageContent {
  title: string;
  url: string;
  text: string;
}

export interface BrowserController {
  open(url: string): Promise<void>;
  read(selectorIntent: string): Promise<PageContent>;
  act(intent: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

/** Допустимые интенты browser.act (валидируются — не enum в рантайме). */
export const BROWSER_INTENTS = ["play", "pause", "next", "prev", "scroll", "click", "type", "back", "forward"] as const;

/** Кандидаты пути chrome.exe (Windows). Чистая функция — тестируется. */
export function chromeCandidates(): string[] {
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] ?? "";
  return [
    join(pf, "Google\\Chrome\\Application\\chrome.exe"),
    join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
    local ? join(local, "Google\\Chrome\\Application\\chrome.exe") : "",
    join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
    join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
  ].filter(Boolean);
}

/** Один CDP-вызов (JSON-RPC). Чистая функция. */
export function cdpCommand(id: number, method: string, params?: Record<string, unknown>): Record<string, unknown> {
  return params ? { id, method, params } : { id, method };
}

/** Скрипт чтения читаемого контента страницы (возвращает JSON-строку). */
export function buildReadScript(): string {
  return `(() => {
    const main = document.querySelector('main, article, [role=main]') || document.body;
    const text = ((main && main.innerText) || '').replace(/[\\t ]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 8000);
    return JSON.stringify({ title: document.title || '', url: location.href, text });
  })()`;
}

/** Скрипт действия по интенту. intent и params — JSON-литералы (анти-инъекция). */
export function buildActScript(intent: string, params?: Record<string, unknown>): string {
  const I = JSON.stringify(intent);
  const P = JSON.stringify(params ?? {});
  return `(() => {
    const I = ${I}; const P = ${P};
    const byText = (t) => [...document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],input[type=submit]')]
      .find(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase().includes(String(t).toLowerCase()));
    const media = () => document.querySelector('video, audio');
    if (I === 'scroll') { window.scrollBy(0, Number(P.dy) || 600); return 'ok'; }
    if (I === 'back') { history.back(); return 'ok'; }
    if (I === 'forward') { history.forward(); return 'ok'; }
    if (I === 'play') { const m = media(); if (m) m.play(); return 'ok'; }
    if (I === 'pause') { const m = media(); if (m) m.pause(); return 'ok'; }
    if (I === 'next' || I === 'prev') {
      const labels = I === 'next' ? ['next','след','вперёд','перемотать вперёд'] : ['prev','пред','назад','предыдущ'];
      const btn = [...document.querySelectorAll('button,[role=button],a')].find(e => {
        const s = ((e.getAttribute('aria-label') || e.title || e.innerText || '')).toLowerCase();
        return labels.some(l => s.includes(l));
      });
      if (btn) { btn.click(); return 'ok'; }
      const m = media(); if (m) m.currentTime += (I === 'next' ? 10 : -10); return 'ok';
    }
    if (I === 'click') {
      const el = P.selector ? document.querySelector(String(P.selector)) : (P.text ? byText(P.text) : null);
      if (!el) throw new Error('элемент для клика не найден');
      el.click(); return 'ok';
    }
    if (I === 'type') {
      const el = P.selector ? document.querySelector(String(P.selector)) : document.activeElement;
      if (!el) throw new Error('поле для ввода не найдено');
      el.focus();
      const v = String(P.text ?? '');
      if ('value' in el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      else { el.textContent = v; }
      return 'ok';
    }
    throw new Error('неизвестный интент: ' + I);
  })()`;
}

// ── минимальный CDP-клиент ───────────────────────────────────────

interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", cb: (ev: { data?: unknown }) => void): void;
  readyState: number;
}

export class CdpBrowserController implements BrowserController {
  private proc?: ChildProcess;
  private ws?: WsLike;
  private port = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private connecting?: Promise<void>;

  constructor(private readonly opts: { headless?: boolean; chromePath?: string; userDataDir?: string } = {}) {}

  async open(url: string): Promise<void> {
    // Браузер ещё не поднят → запускаем его СРАЗУ с целевым URL стартовой страницей,
    // а не с about:blank + последующим navigate (иначе пользователь видит мелькание
    // about:blank → сайт). Если браузер уже работал — переходим на URL обычным navigate.
    const already = Boolean(this.ws && this.ws.readyState === 1);
    await this.ensureConnected(url);
    await this.send("Page.enable");
    if (already) await this.send("Page.navigate", { url });
    await this.waitForLoad();
  }

  async read(_selectorIntent: string): Promise<PageContent> {
    await this.ensureConnected();
    const raw = await this.evaluate(buildReadScript());
    try {
      return JSON.parse(String(raw)) as PageContent;
    } catch {
      return { title: "", url: "", text: String(raw).slice(0, 8000) };
    }
  }

  async act(intent: string, params?: Record<string, unknown>): Promise<void> {
    if (!(BROWSER_INTENTS as readonly string[]).includes(intent)) {
      throw new Error(`browser.act: неизвестный интент «${intent}»`);
    }
    await this.ensureConnected();
    await this.evaluate(buildActScript(intent, params));
  }

  async close(): Promise<void> {
    try { this.ws?.close(); } catch { /* ignore */ }
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.ws = undefined;
    this.proc = undefined;
    this.connecting = undefined;
  }

  // ── внутреннее ─────────────────────────────────────────────────
  // Профиль для ВИДИМОГО режима — РЕАЛЬНЫЙ профиль дефолтного браузера (логины пользователя):
  // Джарвис действует в «его» браузере. Caveat: если браузер уже открыт на этом профиле —
  // singleton-лок не даст поднять debug-порт → CDP не подключится → откат на launchApp.
  // Headless (тесты) — временный профиль. Выбор exe/профиля — в launchAndConnect (авто-детект).

  private ensureConnected(initialUrl = "about:blank"): Promise<void> {
    if (this.ws && this.ws.readyState === 1) return Promise.resolve();
    if (!this.connecting) {
      // ВАЖНО: сбрасываем connecting при сбое (Chrome занят/таймаут), иначе singleton-
      // контроллер навсегда отдаёт отклонённый промис и не восстанавливается до close().
      this.connecting = this.launchAndConnect(initialUrl).catch((e) => {
        this.connecting = undefined;
        throw e;
      });
    }
    return this.connecting;
  }

  private async launchAndConnect(initialUrl: string): Promise<void> {
    // САМОопределение браузера: дефолтный браузер пользователя (Chrome/Edge/Yandex/Brave/…),
    // не захардкоженный Chrome. Явный chromePath/userDataDir (тесты) — в приоритете.
    let exe = this.opts.chromePath;
    let realProfile = this.opts.userDataDir;
    if (!exe || (!realProfile && !this.opts.headless)) {
      const detected = await resolveAutomationBrowser();
      if (!exe) {
        if (!detected) throw new Error("Браузер с поддержкой CDP не найден — браузерная автоматизация недоступна");
        exe = detected.exe;
        log.info("CDP: авто-выбран браузер пользователя", { browser: detected.name, default: detected.isDefault });
      }
      if (!realProfile && !this.opts.headless) realProfile = detected?.userDataDir || undefined;
    }
    this.port = await getFreePort();
    const userDir = this.opts.headless || !realProfile ? await mkdtemp(join(tmpdir(), "jarvis-cdp-")) : realProfile;
    // Мультимонитор (§6): видимое окно браузера ставим на «рабочий» монитор Джарвиса
    // (по умолчанию вторичный) — чтобы не мешать пользователю на основном экране.
    // В headless окна нет — позиция не нужна.
    const winArgs: string[] = [];
    if (!this.opts.headless) {
      try {
        const b = monitors.targetBounds();
        winArgs.push(`--window-position=${Math.round(b.x)},${Math.round(b.y)}`);
        winArgs.push(`--window-size=${Math.round(b.width)},${Math.round(b.height)}`);
      } catch (e) {
        log.warn("позиция монитора недоступна", e instanceof Error ? e.message : String(e));
      }
    }
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${userDir}`,
      `--remote-allow-origins=http://127.0.0.1:${this.port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      ...(this.opts.headless ? ["--headless=new", "--disable-gpu"] : []),
      ...winArgs,
      initialUrl, // стартовая страница = целевой URL (без мелькания about:blank)
    ];
    log.info("CDP: запуск браузера", { exe, port: this.port, headless: Boolean(this.opts.headless) });
    this.proc = spawn(exe, args, { windowsHide: true, stdio: "ignore", detached: false });

    try {
      const wsUrl = await this.discoverWsUrl();
      await this.connectWs(wsUrl);
    } catch (e) {
      // Сбой подключения — НЕ оставляем осиротевший Chrome/WS (утечка процесса/temp).
      try { this.ws?.close(); } catch { /* ignore */ }
      try { this.proc?.kill(); } catch { /* ignore */ }
      this.ws = undefined;
      this.proc = undefined;
      throw e;
    }
  }

  /** Поллим /json до появления page-таргета с webSocketDebuggerUrl. */
  private async discoverWsUrl(): Promise<string> {
    const deadline = Date.now() + 12_000;
    for (;;) {
      try {
        const resp = await fetch(`http://127.0.0.1:${this.port}/json`);
        if (resp.ok) {
          const targets = (await resp.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
          const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
          if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
        }
      } catch {
        /* ещё не поднялся */
      }
      if (Date.now() > deadline) throw new Error("CDP: браузер не открыл debug-порт за 12с");
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Снять состояние соединения и отклонить ожидающие (из error И close). */
  private onWsDown(): void {
    for (const p of this.pending.values()) p.reject(new Error("CDP: соединение закрыто"));
    this.pending.clear();
    this.ws = undefined;
    this.connecting = undefined;
  }

  private connectWs(wsUrl: string): Promise<void> {
    // В main-процессе Electron (Node 20.x) глобального WebSocket нет — берём пакет `ws`
    // (как транспорт). Иначе CDP молча откатывался на launch-only, и невидимый путь не работал.
    const WS =
      (globalThis as { WebSocket?: new (u: string) => WsLike }).WebSocket ??
      (NodeWebSocket as unknown as new (u: string) => WsLike);
    const ws = new WS(wsUrl);
    this.ws = ws;
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP: WS-таймаут")), 8000);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(t); this.onWsDown(); reject(new Error("CDP: ошибка WS")); });
      ws.addEventListener("message", (ev) => this.onMessage(String(ev.data ?? "")));
      ws.addEventListener("close", () => this.onWsDown());
    });
  }

  private onMessage(data: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try { msg = JSON.parse(data); } catch { return; }
    if (typeof msg.id !== "number") return; // событие, не ответ
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`CDP: ${msg.error.message ?? "ошибка"}`));
    else p.resolve(msg.result);
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      if (!this.ws) return reject(new Error("CDP: нет соединения"));
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP: таймаут ${method}`)); }, 15_000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(cdpCommand(id, method, params)));
    });
  }

  private async evaluate(expression: string): Promise<unknown> {
    const r = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails) throw new Error(`browser eval: ${r.exceptionDetails.text ?? "исключение"}`);
    return r.result?.value;
  }

  /** Дождаться document.readyState==='complete' (после navigate). */
  private async waitForLoad(): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const state = await this.evaluate("document.readyState").catch(() => "");
      if (state === "complete" || state === "interactive") return;
      if (Date.now() > deadline) return; // не вешаемся — отдаём что есть
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

let singleton: CdpBrowserController | undefined;
/** Контроллер браузера на сессию main-процесса (ленивый, переиспользует соединение). */
export function browserController(): CdpBrowserController {
  if (!singleton) singleton = new CdpBrowserController();
  return singleton;
}
