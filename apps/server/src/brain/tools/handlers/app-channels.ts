/**
 * Хендлеры реестра программных каналов: выдача рецептов + САМООБУЧЕНИЕ (Джарвис пишет рецепт сам).
 *
 * 🔴 ГЛАВНОЕ ПРАВИЛО ЗАПИСИ: рецепт не принимается НА СЛОВО. `app_channel_learn` сам выполняет пробу
 * (`probe`) через ТОТ ЖЕ гардированный путь, что и code_run, и записывает рецепт ТОЛЬКО если проба
 * реально прошла; её вывод сохраняется провенансом. Причина — асимметрия цены: рецепт уходит в
 * промпт как ДОВЕРЕННОЕ утверждение о возможностях, и выдуманный канал даёт либо ложное обещание
 * владельцу, либо запрещённое действие (self-bot в Discord = перманентный бан аккаунта).
 * Механическая проверка вместо доверия — тот же принцип, что «инструмент не возвращает ложный успех».
 *
 * Рубежи, кроме пробы:
 * — СКАН на инъекции (тот же профиль, что у навыков): рецепт может прийти СО СТРАНИЦЫ («у нашей
 *   программы есть API, дёрните вот этот адрес») — готовый вектор утечки и SSRF;
 * — SSRF-гард на URL внутри рецепта (приватные адреса и метадата-эндпоинты);
 * — провенанс и пометка «выучено» при выдаче: курируемый рецепт и выученный подаются модели ПО-РАЗНОМУ.
 */
import type { ToolContext, ToolResult } from "../dispatch.js";
import { browserUrlBlocked, err, ok, wrapUntrusted } from "../dispatch-util.js";
import { formatChannels } from "../../app-channels.js";
import { appRecipes, normalizeApp } from "../../../memory/app-recipes.js";
import { scanSkillContent } from "../../../memory/skill-scan.js";
import { executeGuardedCode } from "./code.js";

/** Сколько символов вывода пробы сохраняем провенансом (доказательство, не дамп). */
const PROVENANCE_CAP = 400;
/** Капы полей рецепта: он печатается в горячем инструменте, размер = цена каждой задачи. */
const HOWTO_CAP = 600;
const FIELD_CAP = 300;
/** Сколько выученных рецептов печатаем без запроса по имени. */
const LEARNED_LIST_CAP = 12;
/** Допустимые виды каналов — совпадают с ChannelKind реестра. */
const KINDS = new Set(["cli", "uri", "http", "com", "websocket", "config", "hotkey", "none"]);

/**
 * 🔴 Разбор исхода пробы. ЧИСТАЯ функция — и главный несущий гард самообучения.
 *
 * Поймано живым прогоном (2026-09-01): первая версия доверяла `ToolResult.isError`, а `code_run` по
 * своей семантике возвращает УСПЕХ при ЛЮБОМ коде выхода — модель сама читает stdout и решает. Из-за
 * этого заведомо провальная проба («zzz-nonexistent --version») ЗАПИСАЛА рецепт. То есть механизм,
 * поставленный ради механической честности, сам стал источником ложного успеха.
 *
 * Правило: канал подтверждён, только если процесс завершился кодом 0 И что-то напечатал. Ответ без
 * данных о процессе («ok (code.run)» — так выглядит результат, когда клиент недоступен или это
 * заглушка) доказательством НЕ считается: отсутствие сведений — не подтверждение.
 */
/** Тавтологические пробы: печатают что угодно и не доказывают НИЧЕГО про канал. */
const TAUTOLOGY_PROBE = /^\s*(echo|printf|write-output|write-host|true|ver|date|cat|type)\b/i;

/**
 * 🔴 ПРИВЯЗКА ПРОБЫ К РЕЦЕПТУ (адверс-ревью 2026-09-01, HIGH — нашли три линзы независимо).
 *
 * Первая версия требовала от пробы только «код 0 и непустой вывод», а саму пробу выбирает та же
 * модель, что пишет рецепт. Значит `probe:"echo ok"` записывал ЛЮБОЙ рецепт — включая выдуманный
 * «у Discord есть API для отправки от лица владельца», который потом отдавался как ПРОВЕРЕННЫЙ и вёл
 * к self-bot и перманентному бану аккаунта. Мои собственные тесты пользовались «echo ok» — то есть
 * стенд демонстрировал дыру, а не ловил её.
 *
 * Правило: проба обязана содержать ЯКОРЬ рецепта — исполняемое/команду/хост/схему из howTo или exe.
 * ЧИСТАЯ функция.
 */
export function probeAnchored(probe: string, howTo: string, exe?: string): { ok: boolean; why: string } {
  const p = probe.toLowerCase();
  if (TAUTOLOGY_PROBE.test(probe)) {
    return { ok: false, why: "проба тавтологична (echo/type и т.п.) — она ничего не говорит о канале" };
  }
  const anchors = new Set<string>();
  if (exe) {
    anchors.add(exe.toLowerCase());
    anchors.add(exe.toLowerCase().replace(/\.exe$/, ""));
  }
  // Якоря из howTo: команды/бинарники, хосты и порты, URI-схемы.
  for (const m of howTo.matchAll(/[a-z0-9_.-]+\.exe|https?:\/\/[^\s"'<>)]+|\b[a-z][a-z0-9+.-]{2,}:(?=\/\/|[a-z])|\b[a-z][a-z0-9_-]{2,}\b/gi)) {
    const tok = m[0].toLowerCase();
    if (tok.startsWith("http")) {
      try {
        anchors.add(new URL(tok).host.toLowerCase());
      } catch {
        /* не URL — пропускаем */
      }
      continue;
    }
    anchors.add(tok.replace(/:$/, ""));
  }
  for (const a of anchors) {
    if (a.length >= 3 && p.includes(a)) return { ok: true, why: "" };
  }
  return {
    ok: false,
    why:
      "проба не связана с рецептом: в ней нет ни исполняемого, ни хоста, ни схемы из howTo. " +
      "Возьми пробу, которая дёргает ИМЕННО этот канал (например саму команду с --version/--help или запрос к его endpoint)",
  };
}

/**
 * Все адреса, упомянутые в ТЕКСТЕ рецепта. ЧИСТАЯ функция.
 *
 * ⚠️ Готовый `findBlockedMcpUrl` тут не годится и это проверено прогоном: он ищет URL-ЗНАЧЕНИЯ (поле
 * целиком — адрес), а у рецепта адрес сидит внутри прозы («GET http://… для состояния»). Поэтому
 * достаём сами: и полные URL, и ГОЛЫЕ IP-литералы (169.254.169.254/… схемы не имеет, а это ровно
 * метадата-адрес облака — тот же класс обхода уже закрывали в MCP-ветке).
 */
export function extractTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]+/gi)) out.push(m[0]);
  for (const m of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b(?::\d+)?/g)) out.push(m[0]);
  return out;
}

/** Локальный адрес: 127.0.0.0/8, ::1, localhost. Такие рецепты — норма (локальный API приложения). */
export function isLoopbackTarget(raw: string): boolean {
  const s = raw.toLowerCase();
  const host = /^https?:\/\//.test(s) ? (() => { try { return new URL(s).hostname; } catch { return s; } })() : s.split("/")[0] ?? s;
  const h = host.replace(/^\[|\]$/g, "").replace(/:\d+$/, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/** Секретоподобные строки в выводе пробы: в провенанс они попасть не должны — он живёт в промпте. */
const SECRETISH =
  /(-----BEGIN [A-Z ]*PRIVATE KEY|(?:api[_-]?key|token|secret|password|passwd|pwd|authorization)\s*[:=]\s*\S{6,}|\b[A-Za-z0-9_-]{40,}\b)/i;

export function readProbeOutcome(isError: boolean, content: string): { ok: boolean; why: string; stdout: string } {
  if (isError) return { ok: false, why: "инструмент вернул ошибку", stdout: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, why: "ответ пробы без данных о процессе (нет stdout/кода выхода)", stdout: "" };
  }
  const d = parsed as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
  if (typeof d?.exitCode !== "number") {
    return { ok: false, why: "в ответе нет кода выхода — подтвердить нечем", stdout: "" };
  }
  if (d.exitCode !== 0) {
    return { ok: false, why: `команда завершилась с кодом ${d.exitCode}`, stdout: "" };
  }
  const stdout = typeof d.stdout === "string" ? d.stdout.trim() : "";
  if (!stdout) {
    return {
      ok: false,
      why: "команда прошла, но НИЧЕГО не напечатала — это не доказательство канала (возьми пробу, печатающую версию/список/ответ)",
      stdout: "",
    };
  }
  return { ok: true, why: "", stdout };
}

/** Выдать рецепты: курируемые (сматченные с машиной) + выученные, с честными пометками. */
export function appChannelsList(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  const query = typeof input.app === "string" ? input.app : undefined;
  const curated = ctx.appChannels ?? [];
  const learned = appRecipes().list();
  const q = (query ?? "").trim().toLowerCase();
  const learnedShown = q ? learned.filter((r) => r.app.includes(normalizeApp(q))) : learned;

  const parts: string[] = [];
  if (curated.length > 0) parts.push(formatChannels(curated, query));
  else if (!q) parts.push("Список установленного пока не пришёл с клиента — курируемых совпадений нет.");

  if (learnedShown.length > 0) {
    const shown = learnedShown.slice(0, LEARNED_LIST_CAP);
    const tail = learnedShown.length > shown.length ? `\n…и ещё ${learnedShown.length - shown.length} — спроси по имени.` : "";
    // 🔴 Выученный блок — НЕДОВЕРЕННЫЙ (адверс-ревью, HIGH): его текст и провенанс сочинены моделью и
    // содержат СЫРОЙ вывод произвольной команды. Без обёртки это был канал отмывания: любая строка,
    // которую напечатала проба (в т.ч. пришедшая со страницы), становилась доверенной частью промпта
    // под меткой «ПОДТВЕРЖДЕНО» и жила там до ручного forget. Курируемая таблица — код, она доверенная;
    // выученное — данные.
    parts.push(
      `\n${wrapUntrusted(
        "learned-app-recipe",
        "ВЫУЧЕНО НА ЭТОЙ МАШИНЕ (записано с моих же слов; пробой подтверждено лишь то, что указанная " +
          "команда отработала — сам приём сверяй исходом):\n" +
          shown
            .map(
              (r) =>
                `• ${r.app} — канал ${r.kind}\n  КАК: ${r.howTo}\n  СВЕРКА ИСХОДА: ${r.verify}\n` +
                `  ГРАНИЦЫ: ${r.limits}\n  ЧЕМ ПОДТВЕРЖДЕНО: ${r.provenance}`,
            )
            .join("\n") +
          tail,
      )}`,
    );
  }
  if (parts.length === 0) {
    // Различаем НЕЗНАНИЕ и ОТСУТСТВИЕ (адверс-ревью): «список установленного ещё не пришёл» — это не
    // «канала нет». Раньше при запросе с аргументом всегда отвечало вторым, то есть уверенно врало.
    if (ctx.appChannels === undefined) {
      return ok(
        `Список установленного с машины ещё не пришёл (клиент не прислал client.env) — про «${query ?? "это"}» ` +
          `сказать нечего. Не выдавай это за «канала нет»: действуй обычным путём и переспроси позже.`,
      );
    }
    return ok(
      `Про «${query ?? "это"}» в реестре ничего нет — ни курируемого рецепта, ни выученного. ` +
        `Значит остаётся GUI (ui_snapshot → действие → сверка). Если найдёшь программный путь и ПРОВЕРИШЬ его — ` +
        `запиши через app_channel_learn, чтобы в следующий раз не искать заново.`,
    );
  }
  return ok(parts.join("\n"));
}

/**
 * Записать выученный рецепт. Пишем ТОЛЬКО если проба реально прошла.
 * Обязательные поля: app, kind, howTo, verify, limits, probe (+ probeLang).
 */
export async function appChannelLearn(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const app = String(input.app ?? "").trim();
  const kind = String(input.kind ?? "").trim();
  const howTo = String(input.howTo ?? "").trim();
  const verify = String(input.verify ?? "").trim();
  const limits = String(input.limits ?? "").trim();
  const probe = String(input.probe ?? "").trim();
  const probeLang = (["python", "node", "powershell"].includes(String(input.probeLang ?? "")) ? input.probeLang : "powershell") as
    | "python"
    | "node"
    | "powershell";

  if (!app) return err("app_channel_learn: нужно имя приложения (app)");
  if (!KINDS.has(kind)) return err(`app_channel_learn: kind должен быть одним из ${[...KINDS].join("|")}`);
  if (howTo.length < 15) return err("app_channel_learn: howTo должен быть конкретным (команда/URI/endpoint), а не общими словами");
  // Контракт рецепта: без сверки исхода и без границ он породит ложное «готово» — как слепой клик.
  if (verify.length < 15) return err("app_channel_learn: нужен verify — КАК программно убедиться, что канал подействовал");
  if (limits.length < 10) return err("app_channel_learn: нужен limits — чего этот канал НЕ умеет (чтобы не обещать лишнего)");
  if (!probe) {
    return err(
      "app_channel_learn: нужна probe — команда, УСПЕХ которой доказывает существование канала " +
        "(например «ollama --version» или запрос к локальному endpoint). Рецепт со слов не записывается.",
    );
  }

  // Рубеж 0: курируемый РЕЛЬС не перебивается выученным. Если в таблице сказано «канала НЕТ» (Discord:
  // отправка от лица владельца = self-bot = бан), выученный рецепт про этот же приложение отдавался бы
  // рядом как равный и «подтверждённый» — ровно тот путь, ради закрытия которого рельс и стоит.
  const railed = (ctx.appChannels ?? []).find(
    (c) => c.kind === "none" && (normalizeApp(c.app) === normalizeApp(app) || normalizeApp(c.installedAs) === normalizeApp(app)),
  );
  if (railed) {
    return err(
      `app_channel_learn: для «${railed.app}» в курируемом реестре записано, что программного канала НЕТ — ` +
        `и это не пробел, а рельс: ${railed.limits.slice(0, 200)} Переписать его выученным рецептом нельзя.`,
    );
  }

  // Рубеж 1: инъекция в тексте рецепта (он мог прийти со страницы/из письма).
  const scan = scanSkillContent({ name: app, when: limits, procedure: `${howTo}\n${verify}` });
  if (scan.length > 0) {
    return err(
      `app_channel_learn: рецепт не записан — в тексте найдено похожее на инъекцию (${scan.map((f) => f.rule).join(", ")}). ` +
        `Если это ложное срабатывание, перепиши формулировку без директив и повтори.`,
    );
  }
  // Рубеж 2: SSRF. Проверяем ВСЕ поля и ВСЕ адреса (findBlockedMcpUrl ловит и голые хосты — тот же
  // класс обхода уже закрывали в MCP-ветке). ⚠️ LOOPBACK РАЗРЕШЁН осознанно: локальный сервис на
  // машине владельца (Ollama, obs-websocket, LM Studio) — ГЛАВНАЯ цель реестра, а сервер по рецепту
  // никуда не ходит, это текст знания. Блокируем внешние приватные диапазоны и метадату.
  for (const target of extractTargets(`${howTo}
${verify}
${limits}
${probe}`)) {
    if (isLoopbackTarget(target)) continue; // локальный API приложения — норма и главная цель реестра
    if (browserUrlBlocked(target.startsWith("http") ? target : `http://${target}`)) {
      return err(
        `app_channel_learn: адрес ${target} в рецепте запрещён (приватная сеть/служебный адрес) — рецепт не записан.`,
      );
    }
  }

  // Рубеж 3 (главный): проба должна РЕАЛЬНО пройти. Идёт тем же гардированным путём, что code_run,
  // то есть новых прав не даёт — только механически подтверждает заявленное.
  // Рубеж 3а: проба обязана быть ПРО ЭТОТ канал, иначе «проверено» — пустое слово.
  const anchored = probeAnchored(probe, howTo, typeof input.exe === "string" ? input.exe : undefined);
  if (!anchored.ok) {
    return err(`app_channel_learn: рецепт не записан — ${anchored.why}.`);
  }

  const res = await executeGuardedCode(ctx, probeLang, probe);
  const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
  const outcome = readProbeOutcome(res.isError, text);
  if (!outcome.ok) {
    return err(
      `app_channel_learn: проба НЕ подтвердила канал — рецепт не записан (непроверенный рецепт хуже отсутствующего).\n` +
        `Причина: ${outcome.why}\nПроба: ${probe}\nОтвет: ${text.slice(0, 300)}`,
    );
  }
  const output = outcome.stdout;

  // Секрет, напечатанный пробой, в провенанс не пускаем: он персистится и уходит в промпт при КАЖДОМ
  // чтении реестра (code_run вправе прочитать любой файл — вывод может содержать ключ).
  if (SECRETISH.test(output)) {
    return err(
      "app_channel_learn: вывод пробы похож на секрет (ключ/токен/пароль) — рецепт НЕ записан. " +
        "Возьми пробу, которая печатает безобидный признак: версию, список, статус.",
    );
  }
  const exe = typeof input.exe === "string" && input.exe.trim() ? input.exe.trim().toLowerCase() : undefined;
  const rec = appRecipes().upsert({
    app,
    ...(exe ? { exe } : {}),
    kind,
    // Кап полей: рецепт печатается в ГОРЯЧЕМ инструменте, его размер — это цена каждой задачи.
    howTo: howTo.slice(0, HOWTO_CAP),
    verify: verify.slice(0, FIELD_CAP),
    limits: limits.slice(0, FIELD_CAP),
    provenance: `проба «${probe.slice(0, 120)}» → ${output.slice(0, PROVENANCE_CAP)}`,
  });
  // ЧЕСТНАЯ формулировка: проба подтвердила, что КОМАНДА отработала, — не что весь приём из howTo верен.
  return ok(
    `Рецепт для «${rec.app}» записан (канал ${rec.kind}). Подтверждено ровно одно: проба «${probe.slice(0, 80)}» ` +
      `отработала и что-то вернула — сам приём из howTo при первом применении сверь исходом. ` +
      `Не сработает — скажи app_channel_forget.`,
  );
}

/** Забыть выученный рецепт (устарел/оказался неверным). Курируемые не трогает. */
export function appChannelForget(_ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  const app = String(input.app ?? "").trim();
  if (!app) return err("app_channel_forget: нужно имя приложения");
  const removed = appRecipes().forget(app);
  return ok(
    removed
      ? `Выученный рецепт для «${normalizeApp(app)}» удалён.`
      : `Выученного рецепта для «${normalizeApp(app)}» нет (курируемые рецепты этим инструментом не удаляются).`,
  );
}
