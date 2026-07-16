/**
 * «Браузер Джарвиса» (§6, §12) — его СОБСТВЕННЫЙ выделенный Chrome: НЕВИДИМЫЙ (окно за краем
 * всех мониторов + occlusion-off, иначе Chrome усыпит rAF), со СВОИМ профилем (логины
 * пользователя — Telegram/Google/…, входятся один раз видимо). Драйвится ОБЩИМИ CDP-примитивами
 * (open/read/act/type) → Opus сам читает/действует на ЛЮБОМ залогиненном сервисе. Тюнингованные
 * telegramSend/telegramRead — быстрые навыки поверх того же браузера (не вместо общего пути).
 *
 * Архитектурный принцип (см. память project_jarvis_architecture): общие возможности +
 * самообучение, а НЕ хардкод под каждую кнопку. Универсальность: позиция/пути из окружения.
 *
 * НЕ MTProto (userbot отвергнут), НЕ расширение (невидимым быть не может). Текст в управляемые
 * поля webK — ТОЛЬКО нативный CDP Input.insertText (+Enter); подтверждение — по реальному DOM.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screen } from "electron";
import { AsyncMutex, type Candidate, createLogger, nameSearchVariants, pickRecipient } from "@jarvis/shared";
import { chromeCandidates, safeBrowserUrl } from "./browser-cdp.js";
import { type WsLike, cdpCommand, parseCdpReply, resolveWebSocketCtor, unwrapEvalResult } from "./cdp-core.js";
import { PAGE } from "./jarvis-browser-page.js";

const log = createLogger("actuator:jarvis-browser");

const STEALTH_FLAGS = [
  "--disable-features=CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];
const WEBK_URL = "https://web.telegram.org/k/";
const IDLE_CLOSE_MS = 5 * 60 * 1000; // закрыть тёплый браузер после простоя (экономия ресурсов)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Профиль браузера Джарвиса. ASCII-путь ОБЯЗАТЕЛЕН (кириллица ломает IndexedDB webK).
 *  Если LOCALAPPDATA не-ASCII (кириллическое имя пользователя Windows, напр. C:\Users\Антон) —
 *  фолбэк на гарантированно ASCII ProgramData. Логин на диске не теряется при правках кода. */
const isAscii = (s: string): boolean => /^[ -~]*$/.test(s); // printable ASCII (был баг /^[ -]*$/ — мёртвый код, всегда фолбэк)
function profileDir(): string {
  const local = process.env.LOCALAPPDATA || process.env.APPDATA || "";
  const base =
    local && isAscii(local) ? local
    : process.env.ProgramData && isAscii(process.env.ProgramData) ? process.env.ProgramData
    : isAscii(tmpdir()) ? tmpdir()
    : "C:\\JarvisData";
  return join(base, "JarvisTG", "tg-profile");
}

function resolveChrome(): string {
  const exe = chromeCandidates().find((p) => existsSync(p));
  if (!exe) throw new Error("Chrome не найден — браузер Джарвиса недоступен");
  return exe;
}

function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("нет свободного порта"))));
    });
  });
}

/** УНИВЕРСАЛЬНАЯ невидимая позиция: ДАЛЕКО за правым краем ВСЕХ мониторов. Chrome
 *  `--window-position` на Windows — в ФИЗИЧЕСКИХ пикселях, а `screen` отдаёт DIP → переводим через
 *  scaleFactor; плюс большой floor (40000), недостижимый никакой раскладкой/масштабом. occlusion-off
 *  держит рендер за экраном. (НЕ -3000 и НЕ +300 — иначе при масштабе ≠100% окно вылезает на экран.) */
function offscreenPos(): { x: number; y: number } {
  try {
    const displays = screen.getAllDisplays();
    let physRight = 0;
    for (const d of displays) {
      const sf = d.scaleFactor || 1;
      physRight = Math.max(physRight, (d.bounds.x + d.bounds.width) * sf);
    }
    return { x: Math.max(Math.round(physRight) + 1600, 40000), y: 0 };
  } catch {
    return { x: 60000, y: 0 };
  }
}

/** Видимая позиция окна входа — по центру основного монитора; размер клампится под рабочую область
 *  (на малых экранах 660×880 не влезает). Любая раскладка. */
function visibleArgs(): string[] {
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    const w = Math.max(360, Math.min(660, wa.width - 40));
    const h = Math.max(480, Math.min(880, wa.height - 40));
    const x = Math.round(wa.x + Math.max(0, (wa.width - w) / 2));
    const y = Math.round(wa.y + Math.max(0, (wa.height - h) / 2));
    return [`--window-position=${x},${y}`, `--window-size=${w},${h}`];
  } catch {
    return ["--window-size=660,880"];
  }
}

// ── Страничный скрипт (eval внутри страницы). window.__tg = общие хелперы + telegram-навыки. ──
// ── persistent мини-CDP-клиент (общие примитивы — cdp-core.ts) ──
class CdpConn {
  private ws?: WsLike;
  private id = 0;
  private readonly pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  dead = false;

  connect(wsUrl: string): Promise<void> {
    const WS = resolveWebSocketCtor();
    const ws = new WS(wsUrl);
    this.ws = ws;
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP: WS-таймаут")), 10000);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(t); this.dead = true; reject(new Error("CDP: ошибка WS")); });
      ws.addEventListener("message", (ev) => this.onMsg(String(ev.data ?? "")));
      ws.addEventListener("close", () => { this.dead = true; for (const p of this.pending.values()) p.rej(new Error("CDP закрыт")); this.pending.clear(); });
    });
  }

  private onMsg(data: string): void {
    const m = parseCdpReply(data);
    if (!m) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message ?? "CDP error"));
    else p.res(m.result);
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.id;
    return new Promise<unknown>((resolve, reject) => {
      if (!this.ws || this.dead) return reject(new Error("CDP: нет соединения"));
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP: таймаут ${method}`)); }, 30000);
      this.pending.set(id, { res: (v) => { clearTimeout(timer); resolve(v); }, rej: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify(cdpCommand(id, method, params)));
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const raw = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return unwrapEvalResult<T>(raw, "webK eval");
  }

  close(): void { this.dead = true; try { this.ws?.close(); } catch { /* ignore */ } }
}

export interface PageContent { title: string; url: string; text: string; loginWall?: boolean }
export interface TgMessage { dir: "in" | "out"; text: string }
interface OpenResult { ok: boolean; step?: string; chatTitle?: string; peerId?: string; rect?: { x: number; y: number; w: number; h: number } }
interface GatherResult { ok: boolean; step?: string; candidates?: Candidate[] }
/** Подсказка опытной памяти (§ скорость): открыть чат сразу по запомненному резолву. */
export interface TgHint { preferredTitle?: string; hintPeerId?: string }

/** Кука из расширения (chrome.cookies) для импорта в браузер Джарвиса (§перенос логинов). */
export interface ImportCookie {
  name: string;
  value?: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  session?: boolean;
  expirationDate?: number;
}

/**
 * Браузер Джарвиса: ТЁПЛЫЙ невидимый Chrome со своим профилем, общий слой для веб-действий.
 * Один экземпляр на процесс; переиспользует соединение между вызовами (open→read→act компонуются).
 */
export class JarvisBrowser {
  private proc?: ChildProcess;
  private loginProc?: ChildProcess; // видимое окно входа (общий профиль) — трекаем, чтобы убить перед тёплым
  private cdp?: CdpConn;
  private port = 0;
  private injected = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  // Сериализует ВСЕ операции браузера: один браузер — одна страница, нельзя два действия разом;
  // и параллельные вызовы НЕ должны плодить два Chrome на один профиль (singleton-лок → зависание).
  private readonly lock = new AsyncMutex();

  private bumpIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.idleClose(), IDLE_CLOSE_MS);
    if (typeof this.idleTimer === "object" && "unref" in this.idleTimer) (this.idleTimer as { unref?: () => void }).unref?.();
  }

  /** Idle-закрытие: если лок занят in-flight операцией — НЕ рвём её (close() убил бы Chrome/CDP
   *  из-под ног), а перепланируем на следующий цикл простоя. Свободен — закрываем под локом,
   *  чтобы close не пересёкся с операцией, стартовавшей в тот же тик. */
  private idleClose(): void {
    if (this.lock.locked) { this.bumpIdle(); return; }
    void this.lock.run(() => this.close());
  }

  /** Живой тёплый браузер. БЕЗ лока — вызывается уже под this.lock. Перезапуск при мёртвом CDP. */
  private async ensureBrowser(): Promise<CdpConn> {
    if (this.cdp && !this.cdp.dead) {
      try { await this.cdp.evaluate("1"); this.bumpIdle(); return this.cdp; } catch { /* мёртв → перезапуск */ }
    }
    await this.launchWarm();
    this.bumpIdle();
    if (!this.cdp) throw new Error("браузер Джарвиса не поднялся");
    return this.cdp;
  }

  private async launchWarm(): Promise<void> {
    await this.close(); // закрыть прежний невидимый И видимый-вход — освободить общий профиль
    const exe = resolveChrome();
    this.port = await getFreePort();
    const off = offscreenPos();
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${profileDir()}`,
      // НЕ "*": тёплый браузер держит ЖИВЫЕ сессии (Telegram/Google) и слушает CDP на localhost.
      // "*" снимает проверку Origin → любая вкладка/локальный процесс мог бы подключиться к CDP и
      // действовать в твоих логинах. Точный origin оставляет доступ только нашему контролю.
      `--remote-allow-origins=http://127.0.0.1:${this.port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      ...STEALTH_FLAGS,
      `--window-position=${off.x},${off.y}`,
      "--window-size=520,800",
      WEBK_URL,
    ];
    log.info("браузер Джарвиса: запуск (невидимо)", { port: this.port, pos: off });
    const proc = spawn(exe, args, { windowsHide: true, stdio: "ignore", detached: false });
    this.proc = proc;
    // процесс умер сам (краш/обновление/kill) → пометить CDP мёртвым, чтобы ensure перезапустил
    proc.on("exit", () => { if (this.cdp) this.cdp.dead = true; if (this.proc === proc) this.proc = undefined; });
    proc.on("error", (e) => { log.warn("браузер Джарвиса: ошибка процесса", e instanceof Error ? e.message : String(e)); if (this.cdp) this.cdp.dead = true; });
    const wsUrl = await this.discoverWs(this.port);
    const cdp = new CdpConn();
    await cdp.connect(wsUrl);
    this.cdp = cdp;
    this.injected = false;
    await sleep(2500); // дать странице подняться
  }

  private async discoverWs(port: number): Promise<string> {
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/json`);
        if (resp.ok) {
          const targets = (await resp.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
          const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
          if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
        }
      } catch { /* not up */ }
      if (Date.now() > deadline) throw new Error("CDP: debug-порт не открылся за 15с");
      await sleep(250);
    }
  }

  /** window.__tg теряется при навигации → переинъекция по необходимости. */
  private async ensureInjected(cdp: CdpConn): Promise<void> {
    const has = await cdp.evaluate<boolean>("typeof window.__tg === 'object'").catch(() => false);
    if (!has) { await cdp.evaluate(PAGE); this.injected = true; }
  }

  private async waitLoad(cdp: CdpConn): Promise<void> {
    const deadline = Date.now() + 15000;
    for (;;) {
      const s = await cdp.evaluate<string>("document.readyState").catch(() => "");
      if (s === "complete" || s === "interactive") return;
      if (Date.now() > deadline) return;
      await sleep(200);
    }
  }

  private async ensureOnWebK(cdp: CdpConn): Promise<void> {
    const onTg = await cdp.evaluate<boolean>("location.href.indexOf('web.telegram.org') >= 0").catch(() => false);
    if (!onTg) { await cdp.send("Page.navigate", { url: WEBK_URL }); await this.waitLoad(cdp); await sleep(2500); }
    await this.ensureInjected(cdp);
  }

  // ── ОБЩИЕ примитивы (любой сайт). Каждый под this.lock — операции браузера сериализованы. ──
  async open(url: string): Promise<PageContent> {
    return this.lock.run(async () => {
      // C5 защита в глубину: в ЗАЛОГИНЕННОМ браузере Джарвиса открываем ТОЛЬКО http(s). file:///…/id_rsa,
      // chrome://, data: и т.п. — отказ (сервер тоже фильтрует, но клиент не доверяет одному слою);
      // «-»-лидирующий url также отвергаем (флаг-инъекция при spawn окна входа тем же профилем).
      const safe = safeBrowserUrl(url);
      const cdp = await this.ensureBrowser();
      await cdp.send("Page.navigate", { url: safe });
      await this.waitLoad(cdp);
      await sleep(800);
      await this.ensureInjected(cdp);
      return cdp.evaluate<PageContent>("window.__tg.readPage()");
    });
  }

  async read(): Promise<PageContent> {
    return this.lock.run(async () => {
      const cdp = await this.ensureBrowser();
      await this.ensureInjected(cdp);
      return cdp.evaluate<PageContent>("window.__tg.readPage()");
    });
  }

  /**
   * §перенос логинов: импортировать куки (выгруженные расширением из залогиненного Chrome пользователя)
   * в невидимый браузер Джарвиса через CDP Network.setCookie — после этого его браузер залогинен везде.
   * Каждая кука ставится отдельно; сбойная не валит остальные. sameSite/expires маппятся в формат CDP.
   */
  async importCookies(cookies: ImportCookie[]): Promise<{ set: number; total: number }> {
    return this.lock.run(async () => {
      const cdp = await this.ensureBrowser();
      let set = 0;
      for (const c of cookies) {
        if (!c?.name || !c?.domain) continue;
        const ss =
          c.sameSite === "no_restriction" ? "None" : c.sameSite === "lax" ? "Lax" : c.sameSite === "strict" ? "Strict" : undefined;
        const params: Record<string, unknown> = {
          name: c.name,
          value: c.value ?? "",
          domain: c.domain,
          path: c.path || "/",
          secure: ss === "None" ? true : Boolean(c.secure), // SameSite=None требует Secure (иначе CDP отвергнет)
          httpOnly: Boolean(c.httpOnly),
        };
        if (ss) params.sameSite = ss;
        if (!c.session && typeof c.expirationDate === "number") params.expires = c.expirationDate;
        try {
          const r = (await cdp.send("Network.setCookie", params)) as { success?: boolean } | undefined;
          if (!r || r.success !== false) set += 1;
        } catch {
          /* отдельная кука не легла — продолжаем */
        }
      }
      log.info("импорт кук в браузер Джарвиса", { set, total: cookies.length });
      return { set, total: cookies.length };
    });
  }

  /** Инвентарь интерактивных элементов текущей страницы (общий «глаз» для вождения любого сайта). */
  async inspect(query = "", cap = 60): Promise<unknown> {
    return this.lock.run(async () => {
      const cdp = await this.ensureBrowser();
      await this.ensureInjected(cdp);
      return cdp.evaluate(`window.__tg.inspect(${JSON.stringify(query)}, ${Number(cap) || 60})`);
    });
  }

  async act(intent: string, params: Record<string, unknown> = {}): Promise<string> {
    return this.lock.run(async () => {
    const cdp = await this.ensureBrowser();
    await this.ensureInjected(cdp);
    if (intent === "type") {
      if (params.selector) await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(String(params.selector))}); if(e) e.focus();})()`);
      await cdp.send("Input.insertText", { text: String(params.text ?? "") });
      return "ok";
    }
    if (intent === "key") {
      const key = String(params.key ?? "Enter");
      const vk = key === "Enter" ? 13 : key === "Tab" ? 9 : key === "Escape" ? 27 : 0;
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      return "ok";
    }
    // click / scroll — через страничный eval (текст/селектор), JSON-литералы (анти-инъекция)
    const I = JSON.stringify(intent); const P = JSON.stringify(params);
    return cdp.evaluate<string>(`(() => {
      const I = ${I}, P = ${P};
      const byText = (t) => [...document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],[role=menuitem],input[type=submit]')]
        .find(e => ((e.innerText||e.value||e.getAttribute('aria-label')||'')).trim().toLowerCase().includes(String(t).toLowerCase()));
      if (I === 'scroll') { window.scrollBy(0, Number(P.dy)||600); return 'ok'; }
      if (I === 'click') { const el = P.selector ? document.querySelector(String(P.selector)) : (P.text ? byText(P.text) : null); if(!el) throw new Error('элемент не найден'); for(const t of ['pointerdown','mousedown','pointerup','mouseup','click']) el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window})); return 'ok'; }
      throw new Error('неизвестный intent: '+I);
    })()`);
    });
  }

  // ── Тюнингованные навыки Telegram поверх того же браузера (под this.lock). ──

  /**
   * Резолв получателя и ОТКРЫТИЕ чата. RECALL: поиск по оригиналу + транслит-вариантам собирает
   * кандидатов; РЕШЕНИЕ, кто настоящий, принимает `pickRecipient` (при неоднозначности — модель,
   * она знает Герман=Herman/падежи/никнеймы). «Избранное» — через меню. Бросает осмысленную ошибку
   * при not-logged / none / ask (маркер «[tg-resolve]» → сервер не дёргает фолбэк-расширение).
   */
  private async _openChat(cdp: CdpConn, to: string, hint?: TgHint): Promise<{ chatTitle: string; peerId?: string; rect?: { x: number; y: number; w: number; h: number } }> {
    await this.ensureOnWebK(cdp);
    if (/избранн|saved/i.test(to)) {
      const r = await cdp.evaluate<OpenResult>("window.__tg.openSaved()");
      if (!r || !r.ok) {
        if (r?.step === "not-logged-in") { await this._openLogin(); throw new Error("Telegram не залогинен — открыл окно входа. Войдите и повторите."); }
        throw new Error(`telegram: не открыл «Избранное» (этап ${r?.step ?? "?"})`);
      }
      return { chatTitle: r.chatTitle ?? "Saved Messages", rect: r.rect };
    }
    // FAST-PATH (опытная память §): помним резолв «to» → открываем СРАЗУ по имени+peerId, минуя
    // поиск+транслит+дизамбигуацию. Не вышло (контакт переименован/удалён) → общий путь (self-heal:
    // успех общего пути перезапишет память; сервер забудет по resolve-ошибке).
    if (hint?.preferredTitle) {
      const r = await cdp.evaluate<OpenResult>(`window.__tg.openHinted(${JSON.stringify(hint.preferredTitle)}, ${JSON.stringify(hint.hintPeerId ?? "")})`);
      if (r?.ok) { log.info("telegram: fast-path по опытной памяти", { chatTitle: r.chatTitle, peerId: r.peerId }); return { chatTitle: r.chatTitle ?? hint.preferredTitle, peerId: r.peerId, rect: r.rect }; }
    }
    const variants = nameSearchVariants(to); // оригинал + транслит (Герман→German/Herman) — чтобы контакт всплыл
    const gathered = await cdp.evaluate<GatherResult>(
      `window.__tg.gatherCandidates(${JSON.stringify(to)}, ${JSON.stringify(variants)})`,
    );
    if (!gathered || !gathered.ok) {
      if (gathered?.step === "not-logged-in") { await this._openLogin(); throw new Error("Telegram не залогинен — открыл окно входа. Войдите (номер→код→облачный пароль) и повторите."); }
      throw new Error(`telegram: не дошёл до списка чатов (этап ${gathered?.step ?? "?"})`);
    }
    const candidates = gathered.candidates ?? [];
    const pick = pickRecipient(to, candidates); // исключает каналы/паблики, предпочитает МОИ диалоги
    if (pick.action === "none") {
      const seen = candidates.map((c) => c.title).filter(Boolean);
      throw new Error(`[tg-resolve] Не нашёл в Telegram контакт «${to}».${seen.length ? " Видно чаты: " + seen.join(" | ") + "." : ""} Уточни имя получателя.`);
    }
    if (pick.action === "ask") {
      // Кандидаты С peerId (id=…): единственный способ адресовать точно тёзку — повтор с peer нужного.
      const list = pick.ranked.map((c) => `«${c.title}» (id=${c.peerId ?? "?"})`).join(" | ");
      // §P1-тёзки (форензика 2026-07-14, ревью р1): несколько людей носят запрошенное имя — по СМЫСЛУ не
      // решить (обе «Кати» одинаково правдоподобны), выбирает ТОЛЬКО владелец. Точное имя короткой тёзки
      // не разрешит дедлок (снова тёзки), поэтому донести выбор можно ТОЛЬКО peer'ом кандидата.
      if (pick.reason === "namesakes") {
        throw new Error(
          `[tg-resolve] «${to}» — ТЁЗКИ, несколько контактов с этим именем: ${list}. НЕ выбирай сам(а) — ` +
            `СПРОСИ владельца, кому именно, и повтори telegram_send с peer нужного кандидата (id из списка).`,
        );
      }
      throw new Error(
        `[tg-resolve] «${to}» — неоднозначно, наугад не шлю. Кандидаты: ${list}. Выбери того, кто по смыслу = «${to}» ` +
          `(учитывай транслитерацию: Герман≈Herman, падежи, никнеймы) и повтори с peer нужного кандидата (id из списка) ` +
          `или точным именем чата.`,
      );
    }
    const chosen = pick.title ?? to;
    const r = await cdp.evaluate<OpenResult>(`window.__tg.openHinted(${JSON.stringify(chosen)}, ${JSON.stringify(pick.peerId ?? "")})`);
    if (!r || !r.ok) throw new Error(`telegram: не открыл чат «${chosen}» (этап ${r?.step ?? "?"})`);
    return { chatTitle: r.chatTitle ?? chosen, peerId: r.peerId, rect: r.rect };
  }

  async telegramSend(to: string, text: string, hint?: TgHint): Promise<{ delivered: boolean; chatTitle: string; peerId?: string }> {
    if (!to.trim() || !text.trim()) throw new Error("telegram: нужны to и text");
    return this.lock.run(async () => {
      const cdp = await this.ensureBrowser();
      const opened = await this._openChat(cdp, to, hint);
      if (opened.rect && opened.rect.w > 0) {
        const cx = opened.rect.x + opened.rect.w / 2, cy = opened.rect.y + opened.rect.h / 2;
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
        await sleep(200);
      }
      await cdp.send("Input.insertText", { text });
      await sleep(500);
      const typed = await cdp.evaluate<{ text: string }>("window.__tg.typed()");
      if (!typed || !typed.text) throw new Error("telegram: текст не лёг в поле ввода");
      const enter = (type: "keyDown" | "keyUp") => cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await enter("keyDown"); await enter("keyUp");
      await sleep(1300);
      const verify = await cdp.evaluate<{ delivered: boolean }>(`window.__tg.verify(${JSON.stringify(text)})`);
      if (!verify || !verify.delivered) throw new Error("telegram: сообщение не появилось в чате — не доставлено");
      log.info("telegram доставлено", { chatTitle: opened.chatTitle, peerId: opened.peerId });
      return { delivered: true, chatTitle: opened.chatTitle, peerId: opened.peerId };
    });
  }

  async telegramRead(to: string, count = 12, hint?: TgHint): Promise<{ chatTitle: string; messages: TgMessage[] }> {
    if (!to.trim()) throw new Error("telegram: нужен to (чат)");
    return this.lock.run(async () => {
      const cdp = await this.ensureBrowser();
      const opened = await this._openChat(cdp, to, hint);
      await sleep(800);
      const res = await cdp.evaluate<{ messages?: TgMessage[] }>(`window.__tg.collectMessages(${Number(count) || 12})`);
      return { chatTitle: opened.chatTitle, messages: res?.messages ?? [] };
    });
  }

  /** Открыть ВИДИМОЕ окно входа в сервис (под локом — не конфликтует с тёплым на общем профиле). */
  async openLogin(url = WEBK_URL): Promise<void> {
    return this.lock.run(() => this._openLogin(url));
  }

  /** Без лока — вызывается изнутри уже залоченной операции (telegramSend/Read при not-logged-in). */
  private async _openLogin(url = WEBK_URL): Promise<void> {
    // Санитайзер до spawn: url может прийти от модели (openLogin с произвольным url). ТОЛЬКО
    // http(s), и НЕ «-»-лидирующий аргумент — иначе Chrome примет его в argv за флаг
    // (--load-extension/--proxy-server и т.п. — флаг-инъекция в невидимый залогиненный профиль).
    const safe = safeBrowserUrl(url);
    await this.close(); // закрыть тёплый невидимый — освободить профиль
    const exe = resolveChrome();
    const port = await getFreePort();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir()}`,
      "--no-first-run", "--no-default-browser-check",
      ...visibleArgs(),
      safe,
    ];
    const proc = spawn(exe, args, { windowsHide: false, stdio: "ignore", detached: true });
    proc.unref();
    this.loginProc = proc; // трекаем, чтобы убить перед поднятием тёплого (иначе лок профиля)
    log.info("открыто видимое окно входа", { url: safe, profile: profileDir() });
  }

  async close(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    try { this.cdp?.close(); } catch { /* ignore */ }
    try { this.proc?.kill(); } catch { /* ignore */ }
    try { this.loginProc?.kill(); } catch { /* ignore */ } // закрыть видимое окно входа (тот же профиль)
    this.cdp = undefined;
    this.proc = undefined;
    this.loginProc = undefined;
    this.injected = false;
  }
}

let singleton: JarvisBrowser | undefined;
export function jarvisBrowser(): JarvisBrowser {
  if (!singleton) singleton = new JarvisBrowser();
  return singleton;
}
