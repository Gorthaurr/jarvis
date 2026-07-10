/**
 * Диспетчер актуаторов: ActionCommand -> ActionResult (§5, §6).
 *
 * Контракт (§5): на КАЖДЫЙ ActionCommand клиент обязан вернуть ровно один ActionResult,
 * корреляция по commandId (= envelope.id). durationMs обязателен.
 *
 * Реализованы: app.launch/focus, browser.open/act/read (apps.ts/browser.ts);
 * input.type/key/click, ui.ground/invoke, context.read — через нативный win-сайдкар
 * (sidecar-client, UIAutomation+SendInput); code.run (code-runner); skill.execute
 * (skill-runner); message.send (userbot); order.place (browser). Ввод/UIA требуют
 * запущенного сайдкара — если он не поднят, актуатор честно вернёт runtime-ошибку.
 * screen.capture (§ зрение) — Electron desktopCapturer, см. screen.ts. НЕ реализованы:
 * demo.record как ActionCommand (M4 — запись навыка инициируется отдельным путём, не через dispatch).
 */
import { powerMonitor } from "electron";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import * as apps from "./apps.js";
import * as input from "./input.js";
import * as ground from "./ground.js";
import * as windows from "./windows.js";
import * as browser from "./browser.js";
import * as codeRunner from "./code-runner.js";
import * as fs from "./fs.js";
import { type CaptureRect, captureScreen, getLastCaptureMapping, probeScreen } from "./screen.js";
import { screenOcr, waitFor } from "./sensors-cheap.js";
import { observeAfterAction } from "./observe.js";
import * as system from "./system.js";
import * as office from "./office.js";
import * as obs from "./obs.js";
import { outcomeToActionResult, runSkill } from "../skill-runner/index.js";
import { createClientActuator } from "../skill-runner/client-actuator.js";
import * as messaging from "./messaging.js";
import { jarvisBrowser } from "./jarvis-browser.js";
import { isUserActive } from "./user-presence.js";
import { monitors } from "../monitors.js";

const log = createLogger("actuators");

/**
 * НЕ МЕШАТЬ ПОЛЬЗОВАТЕЛЮ (§): инъекция физического ввода (мышь/клавиатура через SendInput) уводит
 * курсор и шлёт нажатия в активное окно — если пользователь СЕЙЧАС играет/работает, это сбивает его.
 * Правило: пользователь простаивает (не вводил ничего N сек) → действуем; пользователь активен → НЕ
 * лезем, честно сообщаем (модель озвучит «вижу, вы заняты — не хочу мешать»). Сигнал — системное время
 * простоя (Electron powerMonitor.getSystemIdleTime, секунды с последнего ввода ЛЮБОГО источника).
 */
const USER_ACTIVE_THRESHOLD_MS = 4000;
/** Ввод САМОГО Джарвиса (SendInput) тоже сбрасывает системный idle — не считаем его «активностью юзера». */
const JARVIS_INPUT_TOLERANCE_MS = 900;
/** Когда Джарвис последний раз сам инжектил ввод (для отсечки собственного ввода из детекта активности). */
let lastJarvisInputAt = 0;
/** Команды, которые ФИЗИЧЕСКИ инжектят ввод в сессию пользователя (в отличие от UIA-invoke/CDP). */
const PHYSICAL_INPUT_KINDS = new Set<ActionCommand["kind"]>(["input.click", "input.type", "input.key", "input.mouse"]);

/**
 * Активен ли пользователь ПРЯМО СЕЙЧАС (недавно вводил сам, а не Джарвис). Логика — в user-presence.
 * Экспортируется, чтобы skill-runner применял ТОТ ЖЕ гейт присутствия к физ.вводу проактивного навыка
 * (иначе skill.execute → createClientActuator дёргал бы input.* в обход USER_BUSY-сторожа dispatch, H5).
 */
export function userActiveNow(): boolean {
  let idleMs: number;
  try {
    idleMs = Math.round(powerMonitor.getSystemIdleTime() * 1000);
  } catch {
    return false; // нет сигнала простоя — не блокируем (fail-open)
  }
  return isUserActive({
    idleMs,
    lastJarvisInputAt,
    now: Date.now(),
    thresholdMs: USER_ACTIVE_THRESHOLD_MS,
    toleranceMs: JARVIS_INPUT_TOLERANCE_MS,
  });
}

/** Собрать успешный результат с замером длительности. */
function okResult(commandId: string, startedAt: number, data?: unknown): ActionResult {
  return { commandId, ok: true, data, durationMs: Date.now() - startedAt };
}

/** Собрать результат-ошибку (коды строго из протокола). */
function errResult(
  commandId: string,
  startedAt: number,
  code: NonNullable<ActionResult["error"]>["code"],
  message: string,
): ActionResult {
  return { commandId, ok: false, error: { code, message }, durationMs: Date.now() - startedAt };
}

/** Честный «не реализовано на этом milestone» (§17). */
function notImplemented(commandId: string, startedAt: number, milestone: string): ActionResult {
  return errResult(commandId, startedAt, "runtime", `not implemented (${milestone})`);
}

/**
 * Исполнить команду. commandId приходит из envelope.id (см. transport).
 * Любое исключение из актуатора маппится в error.runtime — наружу не утекает.
 */
export async function dispatch(commandId: string, cmd: ActionCommand): Promise<ActionResult> {
  const startedAt = Date.now();
  log.info(`dispatch ${cmd.kind} (commandId=${commandId})`);

  try {
    // §: НЕ МЕШАТЬ активному пользователю — но ТОЛЬКО когда действие ПРОАКТИВНОЕ (Джарвис сам затеял).
    // ЗАПРОШЕННЫЙ физ-ввод (юзер сам попросил настроить/кликнуть) НЕ блокируем: он в курсе, мешать нечему
    // (фикс «дал сложную задачу — а он отказался: вы активны в браузере»). Глушим лишь `proactive===true`.
    const isProactive = cmd.origin === "proactive" || cmd.proactive === true; // §бесшумный-ввод: канон — origin
    if (isProactive && PHYSICAL_INPUT_KINDS.has(cmd.kind) && userActiveNow()) {
      const idleS = (() => {
        try {
          return powerMonitor.getSystemIdleTime().toFixed(1);
        } catch {
          return "?";
        }
      })();
      log.info(`physical-input «${cmd.kind}» отложен: пользователь активен (idle ${idleS}s)`);
      return errResult(
        commandId,
        startedAt,
        "denied",
        `USER_BUSY: пользователь сам за вводом (~${idleS}с назад), физическую мышь/клавиатуру сейчас не трогаю. ` +
          `НЕ сдавайся и НЕ перекладывай на пользователя. Если это ВЕБ — сделай через browser_open/browser_act ` +
          `(они работают в его вкладках и НЕ трогают мышь/клаву, мешать не будут). Если нативное окно/игра — ` +
          `повтори через пару секунд или зайди иначе (code_run и т.п.). ЗАПРЕЩЕНО говорить «сделайте сами», ` +
          `«нажмите Ctrl+…», «не умею» — работу с себя не снимай.`,
      );
    }

    switch (cmd.kind) {
      // ── РЕАЛЬНО в M0 ──────────────────────────────────────────
      case "app.launch": {
        const out = await apps.launchApp(cmd.app);
        return okResult(commandId, startedAt, out);
      }
      case "app.focus": {
        const out = await apps.focusApp(cmd.app);
        // ЧЕСТНОСТЬ (баг из живого прогона): focused===false → приложение не запущено / окно не вышло
        // на передний план. НЕ возвращаем ok, иначе модель соврёт «переключил» на несуществующее.
        if (!out.focused) {
          return errResult(
            commandId,
            startedAt,
            "not_found",
            `не сфокусировал «${cmd.app}»: приложение не запущено или окно не вышло на передний план. Запусти его (app_launch) или проверь имя.`,
          );
        }
        return okResult(commandId, startedAt, out);
      }
      case "app.close": {
        // §6 БЕЗОПАСНОЕ закрытие по процессу (НЕ Alt+F4): self-exclusion внутри closeApp
        // не даст закрыть сам Джарвис/критический процесс.
        const out = await apps.closeApp(cmd.app, cmd.force ?? false);
        // ЧЕСТНОСТЬ (баг из живого прогона): closed===0 → НИЧЕГО не закрыли (процесс не найден/не
        // поддался graceful-закрытию). НЕ возвращаем ok, иначе модель соврёт «закрыл». Пусть увидит
        // провал и зайдёт иначе (force=true / другое имя процесса / проверка глазами).
        if (out.closed === 0) {
          return errResult(
            commandId,
            startedAt,
            "not_found",
            `не закрыл «${cmd.app}»: подходящий запущенный процесс не найден или не закрылся штатно. ` +
              `Проверь имя процесса или повтори с force=true (жёсткое закрытие).`,
          );
        }
        return okResult(commandId, startedAt, out);
      }
      case "browser.open": {
        // inDefault (консьерж «просто открой/включи»): открыть в ДЕФОЛТНОМ (залогиненном) браузере
        // пользователя через shell — его сессия/логины, мгновенно, без CDP-инстанса и без 12с
        // singleton-лага, физическую мышь НЕ трогаем. Управление (browser.act) тут не нужно.
        if (cmd.inDefault) {
          const out = await apps.launchApp(cmd.url);
          return okResult(commandId, startedAt, { ...out, url: cmd.url, controlled: false, inDefault: true });
        }
        // Управляемый браузер (CDP) — чтобы дальше работали browser.act/read на этой же
        // странице. Нет Chrome / сбой CDP → мягкий откат на запуск дефолтного браузера.
        try {
          await browser.open(cmd.url);
          return okResult(commandId, startedAt, { url: cmd.url, controlled: true });
        } catch (e) {
          log.warn(`browser.open CDP не удался (${e instanceof Error ? e.message : String(e)}) — откат на launchApp`);
          const out = await apps.launchApp(cmd.url);
          return okResult(commandId, startedAt, { ...out, controlled: false });
        }
      }

      // ── Синтетический ввод (§Волна2 2.1: fused act+observe — наблюдение в ТОМ ЖЕ результате) ──
      case "input.type": {
        await input.typeText(cmd.text);
        lastJarvisInputAt = Date.now(); // наш ввод сбросит системный idle — пометим, чтобы не счесть «юзер активен»
        const observation = await observeAfterAction({ settleMs: 150 });
        return okResult(commandId, startedAt, observation ? { observation } : undefined);
      }
      case "input.key": {
        await input.pressKey(cmd.combo, cmd.mode, cmd.scancode);
        lastJarvisInputAt = Date.now();
        // Игровое удержание (down/up) — середина жеста, наблюдение неуместно (см. Волна2 2.1).
        const observation = cmd.mode === "down" || cmd.mode === "up" ? undefined : await observeAfterAction({ settleMs: 250 });
        return okResult(commandId, startedAt, observation ? { observation } : undefined);
      }
      case "input.click": {
        // §бесшумный-ввод: по умолчанию silent (без курсора); физ.клик-фолбэк возвращает курсор, ЕСЛИ юзер
        // сейчас НЕ двигает мышь сам (иначе не дёргаем — оставляем курсор там, где он у него).
        // Разрешённые экранные координаты возвращаем в data — сервер компилирует из них реплей-макрос (§8).
        const clicked = await input.click(cmd.target, cmd.method ?? "silent", !userActiveNow(), {
          button: cmd.button,
          count: cmd.count,
        });
        lastJarvisInputAt = Date.now();
        // §Волна2 (2.1): наблюдение после клика — a11y-выжимка / OCR региона вокруг точки.
        const observation = await observeAfterAction({
          settleMs: 400,
          clickPoint: clicked ? { x: clicked.screenX, y: clicked.screenY } : undefined,
        });
        return okResult(commandId, startedAt, observation ? { ...clicked, observation } : clicked);
      }
      case "input.mouse": {
        // §Волна2 (2.4): полная мышь — hover/удержание/колесо/перетаскивание (DnD, контекст-меню, игры).
        await input.mouse(cmd);
        lastJarvisInputAt = Date.now();
        // Наблюдение — для завершённых жестов (drag/wheel/up); move/down — середина жеста.
        const wantsObserve = cmd.op === "drag" || cmd.op === "wheel" || cmd.op === "up";
        // Точка для OCR-региона — конец drag в экранных DIP (координаты команды — vision-координаты
        // последнего снимка, кроме space:"screen"; маппинг тот же, что внутри input.mouse).
        const dragEnd = (() => {
          if (cmd.op !== "drag" || cmd.toX === undefined || cmd.toY === undefined) return undefined;
          if (cmd.space === "screen") return { x: cmd.toX, y: cmd.toY };
          const m = getLastCaptureMapping();
          return m ? { x: m.boundsX + cmd.toX / m.scale, y: m.boundsY + cmd.toY / m.scale } : { x: cmd.toX, y: cmd.toY };
        })();
        const observation = wantsObserve
          ? await observeAfterAction({ settleMs: 400, clickPoint: dragEnd })
          : undefined;
        return okResult(commandId, startedAt, observation ? { op: cmd.op, observation } : { op: cmd.op });
      }
      case "ui.invoke": {
        await ground.invoke(cmd.target, cmd.pattern, cmd.value);
        const observation = await observeAfterAction({ settleMs: 350 });
        return okResult(commandId, startedAt, observation ? { observation } : undefined);
      }
      case "ui.ground": {
        const g = await ground.ground(cmd.query);
        return okResult(commandId, startedAt, g);
      }
      case "ui.snapshot": {
        // §Волна2 (2.4): set-of-marks — интерактивные элементы окна одним дешёвым списком.
        const snap = await ground.uiSnapshot(cmd.pid, cmd.maxItems);
        return okResult(commandId, startedAt, snap);
      }
      case "window.list": {
        // §Волна2 (2.4): окна верхнего уровня on-demand («появилось ли окно» за миллисекунды).
        return okResult(commandId, startedAt, { windows: await windows.listWindows() });
      }
      case "window.focus": {
        // §Волна2 (2.4): фокус через сайдкар (SetForegroundWindow+AttachThreadInput, честный readback);
        // провал ЛЮБОЙ ветки (не сфокусировал / окно не найдено / сайдкар лежит — ревью: раньше throw
        // проскакивал мимо фолбэка) → AppActivate-путь по query, затем честная ошибка.
        let r: Awaited<ReturnType<typeof windows.focusWindow>> | null = null;
        let sidecarErr = "";
        try {
          r = await windows.focusWindow({ hwnd: cmd.hwnd, query: cmd.query });
        } catch (e) {
          sidecarErr = e instanceof Error ? e.message : String(e);
        }
        if (r?.focused) {
          lastJarvisInputAt = Date.now();
          return okResult(commandId, startedAt, r);
        }
        if (cmd.query) {
          const legacy = await apps.focusApp(cmd.query);
          if (legacy.focused) {
            lastJarvisInputAt = Date.now();
            return okResult(commandId, startedAt, { focused: true, hwnd: r?.hwnd ?? 0, title: r?.title ?? cmd.query, via: "AppActivate" });
          }
        }
        return errResult(
          commandId,
          startedAt,
          "runtime",
          r
            ? `окно найдено («${r.title}»), но фокус не перешёл (foreground-lock). Попробуй app_focus или проверь, не заблокирован ли рабочий стол.`
            : `фокус не взят: ${sidecarErr || "окно не найдено"}. Проверь имя/hwnd через window_list.`,
        );
      }
      case "browser.act":
        await browser.act(cmd.intent, cmd.params);
        return okResult(commandId, startedAt);
      case "browser.read": {
        const r = await browser.read(cmd.selectorIntent);
        return okResult(commandId, startedAt, r);
      }
      case "code.run": {
        const r = await codeRunner.run(cmd.lang, cmd.code);
        // ЧЕСТНОСТЬ (ревью C1): ненулевой exitCode = скрипт УПАЛ (исключение / sys.exit(1) / таймаут).
        // Раньше всегда okResult → модель видела «успех» и врала «готово, результат N», а exitCode/stderr
        // прятались в JSON. Теперь провал явный: модель видит ошибку и заходит иначе.
        if (r.exitCode !== 0) {
          return errResult(
            commandId,
            startedAt,
            "runtime",
            `код завершился с кодом ${r.exitCode}${r.exitCode === -1 ? " (таймаут/прервано)" : ""}. ` +
              `stderr: ${(r.stderr || "").slice(0, 500) || "(пусто)"}${r.stdout ? ` | stdout: ${r.stdout.slice(0, 300)}` : ""}`,
          );
        }
        return okResult(commandId, startedAt, r);
      }

      // ── skill-runner (tier-0.5, §8): локальное исполнение шагов без LLM ──
      case "skill.execute": {
        const cancel = { cancelled: false }; // TODO(M8): связать с отменой задачи (§20)
        // H5: тот же USER_BUSY-гейт, что в dispatch — навык, запущенный ПРОАКТИВНО (Джарвис сам затеял),
        // не должен инжектить физ.мышь/клаву мимо сторожа. Явный (origin==="user") навык НЕ гейтим.
        const skillProactive = cmd.origin === "proactive" || cmd.proactive === true;
        const outcome = await runSkill({
          skillId: cmd.skillId,
          version: cmd.version,
          steps: cmd.steps,
          params: cmd.params,
          cancel,
          actuator: createClientActuator({ isProactive: skillProactive, userActiveNow }),
          // escalate (needs_llm: сочинить значение шага по месту; exhausted: починка) — клиент↔сервер
          // round-trip ещё не подключён (TODO M4+). Пока хук не передаётся → раннер честно ВАЛИТ
          // needsLlm-шаг (не исполняет вслепую с незаполненным плейсхолдером). Детерминированные шаги
          // (в т.ч. со слотами, заполненными сервером в cmd.params) исполняются как прежде, $0/без LLM.
        });
        const skillRes = outcomeToActionResult(commandId, outcome, Date.now() - startedAt);
        // §Волна2 (2.1/2.2): успешный реплей/берст — приложить наблюдение итогового состояния
        // (fused observe): сервер увидит реальный экран в том же tool_result.
        if (skillRes.ok) {
          const observation = await observeAfterAction({ settleMs: 400 });
          if (observation) skillRes.data = { observation };
        }
        return skillRes;
      }
      case "screen.capture":
        // Зрение (§): снять активный монитор (под курсором) / выбранный → base64 PNG в ActionResult.data.
        // §Волна2 (2.3): rect/scale — кроп региона (~50-200 ток) вместо полного кадра.
        return okResult(
          commandId,
          startedAt,
          await captureScreen(cmd.monitor, {
            rect: cmd.rect as CaptureRect | undefined,
            scale: cmd.scale,
          }),
        );
      case "screen.ocr": {
        // §Волна2 (2.3): локальный OCR (Windows.Media.Ocr в сайдкаре) — текст с экрана без vision-раунда.
        const ocr = await screenOcr(cmd.monitor, cmd.rect as CaptureRect | undefined, cmd.lang);
        return okResult(commandId, startedAt, ocr);
      }
      case "screen.probe": {
        // §Волна2 (2.3): $0-проба «изменилось ли» — перцептивный хеш региона (НЕ доказательство успеха).
        return okResult(commandId, startedAt, await probeScreen(cmd.monitor, cmd.rect as CaptureRect | undefined));
      }
      case "wait.for": {
        // §Волна2 (2.3): клиентское ожидание события (UIA/окно/OCR-текст/звук) — без LLM-поллинга.
        // met:false по таймауту — ЧЕСТНЫЙ исход в data (модель решает сама), не ошибка транспорта.
        const w = await waitFor(cmd.condition, cmd.timeoutMs, cmd.pollMs);
        return okResult(commandId, startedAt, w);
      }
      case "context.read": {
        // Дейксис (§19): selection/active_window через сайдкар (TextPattern); screen — vision (позже).
        const text = await ground.readContext(cmd.scope);
        return okResult(commandId, startedAt, { scope: cmd.scope, text });
      }
      case "demo.record":
        return notImplemented(commandId, startedAt, "M4");
      case "message.send": {
        // Гарды §14 (confirm/cadence/idempotency) уже пройдены на сервере; здесь — доставка userbot'ом (§12).
        const out = await messaging.sendMessage(cmd.channel, cmd.to, cmd.body);
        return okResult(commandId, startedAt, out);
      }
      case "telegram.send": {
        // НЕВИДИМАЯ отправка в Telegram через браузер Джарвиса (off-screen Chrome + CDP, §6).
        // НЕ MTProto/userbot (см. message.send) — реальный webK в скрытом окне. hint — опытная память.
        const out = await jarvisBrowser().telegramSend(cmd.to, cmd.text, { preferredTitle: cmd.preferredTitle, hintPeerId: cmd.hintPeerId });
        return okResult(commandId, startedAt, out);
      }
      case "telegram.read": {
        const out = await jarvisBrowser().telegramRead(cmd.to, cmd.count, { preferredTitle: cmd.preferredTitle, hintPeerId: cmd.hintPeerId });
        return okResult(commandId, startedAt, out);
      }
      // «Браузер Джарвиса» (§6): общие невидимые примитивы над его залогиненным профилем.
      case "jbrowser.open": {
        const out = await jarvisBrowser().open(cmd.url);
        return okResult(commandId, startedAt, out);
      }
      case "jbrowser.read": {
        const out = await jarvisBrowser().read();
        return okResult(commandId, startedAt, out);
      }
      case "jbrowser.inspect": {
        const out = await jarvisBrowser().inspect(cmd.query ?? "", cmd.cap ?? 60);
        return okResult(commandId, startedAt, out);
      }
      case "jbrowser.act": {
        const out = await jarvisBrowser().act(cmd.intent, cmd.params);
        return okResult(commandId, startedAt, out);
      }
      case "jbrowser.login": {
        // Не залогинен на сервисе → открыть его страницу ВИДИМО (тот же профиль), пользователь
        // входит один раз, дальше Джарвис действует невидимо (§6, общий слой логина).
        await jarvisBrowser().openLogin(cmd.url);
        return okResult(commandId, startedAt, { opened: cmd.url });
      }
      case "jbrowser.import_cookies": {
        // §перенос логинов: куки из расширения (расшифрованные, минуя ABE) → CDP setCookie в браузер Джарвиса.
        const out = await jarvisBrowser().importCookies(cmd.cookies as unknown as Parameters<ReturnType<typeof jarvisBrowser>["importCookies"]>[0]);
        return okResult(commandId, startedAt, out);
      }
      case "order.place": {
        // Гарды §14 пройдены на сервере; здесь — browser-автоматизация без ввода карты (§0).
        const out = await browser.placeOrder({ vendor: cmd.vendor, items: cmd.items, total: cmd.total });
        return okResult(commandId, startedAt, out);
      }

      // ── Файловая система (§6): прямое управление файлами ──────
      case "fs.read":
        return okResult(commandId, startedAt, await fs.readFile(cmd.path, cmd.maxBytes));
      case "fs.write":
        return okResult(commandId, startedAt, await fs.writeFile(cmd.path, cmd.content, cmd.createDirs));
      case "fs.edit":
        return okResult(commandId, startedAt, await fs.editFile(cmd.path, cmd.old, cmd.new, cmd.replaceAll));
      case "fs.append":
        return okResult(commandId, startedAt, await fs.appendFile(cmd.path, cmd.content));
      case "fs.list":
        return okResult(commandId, startedAt, await fs.listDir(cmd.path, cmd.recursive));
      case "fs.delete":
        // Необратимо: confirm уже взят на сервере (§4); здесь — исполнение.
        return okResult(commandId, startedAt, await fs.deleteEntry(cmd.path, cmd.recursive));
      case "fs.move":
        return okResult(commandId, startedAt, await fs.moveEntry(cmd.from, cmd.to));
      case "fs.mkdir":
        return okResult(commandId, startedAt, await fs.makeDir(cmd.path));
      case "fs.search":
        return okResult(commandId, startedAt, await fs.search(cmd.root, cmd.query, cmd.inContent, cmd.maxResults));

      // ── Системное управление (§6): питание/блокировка/медиа/громкость/буфер ──
      case "system.lock":
      case "system.power":
      case "system.media":
      case "system.volume":
      case "system.clipboard":
      case "system.layout":
        return okResult(commandId, startedAt, await system.runSystem(cmd));

      // ── Office как живые приложения (§6): Word/Excel через COM ──
      case "office.excel":
        return okResult(commandId, startedAt, await office.runExcel(cmd));
      case "office.word":
        return okResult(commandId, startedAt, await office.runWord(cmd));

      // ── OBS Studio через obs-websocket v5 (§): программное управление вместо кликов ──
      case "obs.request":
        return okResult(commandId, startedAt, await obs.request(cmd.requestType, cmd.requestData));

      // ── Мультимонитор (§6): куда уводить видимую активность Джарвиса ──
      case "monitor.set": {
        monitors.setTarget(cmd.target);
        return okResult(commandId, startedAt, { target: cmd.target, summary: monitors.summary() });
      }
      case "monitor.list": {
        return okResult(commandId, startedAt, monitors.monitorList());
      }
      case "monitor.assign": {
        const list = monitors.monitorList();
        if (cmd.index !== null && (cmd.index < 0 || cmd.index >= list.monitors.length)) {
          // честный провал: индекс вне диапазона (а не молчаливое игнорирование)
          throw new Error(`нет монитора с номером ${cmd.index + 1} — всего мониторов ${list.monitors.length}`);
        }
        monitors.setJarvisIndex(cmd.index);
        return okResult(commandId, startedAt, monitors.monitorList());
      }

      default: {
        // Исчерпывающая проверка union: при добавлении нового kind тут будет ошибка типа.
        const _exhaustive: never = cmd;
        return errResult(commandId, startedAt, "runtime", `unknown kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error(`actuator ${cmd.kind} упал: ${message}`);
    // NotImplementedError из стабов — это тоже runtime-ошибка наружу (честно).
    return errResult(commandId, startedAt, "runtime", message);
  }
}
