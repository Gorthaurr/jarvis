/**
 * Реестр программных каналов: сопоставление установленного с рецептами + ЧЕСТНОСТЬ сводки.
 *
 * Корень (форензика 2026-09-01): список приложений был захардкожен девятью путями, из них на машине
 * нашлось три — и Джарвис ходил кликами там, где у программы есть команда или протокол. Живое
 * перечисление реестра нашло 96 приложений и 17 зарегистрированных протоколов.
 *
 * Главный честностный инвариант здесь: запись «канала НЕТ» (Discord — программная отправка от лица
 * владельца запрещена под баном) не должна попадать в строку «каналы есть у: …».
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHANNEL_RECIPES, TOP_APPS_SEED, channelForProcess, channelSummary, exeName, formatChannels, formatUsageCoverage, type InstalledApp, isGenericExeName, matchChannels, recipeMatches, sanitizeUsage } from "./app-channels.js";
import { browserUrlBlocked } from "./tools/dispatch-util.js";

const app = (name: string, exe?: string, uri?: string) => ({ name, exe, uri });

describe("контракт рецептов", () => {
  it("у КАЖДОГО рецепта заполнены сверка исхода и границы", () => {
    for (const r of CHANNEL_RECIPES) {
      expect(r.verify.trim().length, `${r.app}: пустая сверка`).toBeGreaterThan(20);
      expect(r.limits.trim().length, `${r.app}: пустые границы`).toBeGreaterThan(20);
      expect(r.howTo.trim().length, `${r.app}: пустой howTo`).toBeGreaterThan(20);
    }
  });

  it("каждый рецепт ДОСТИЖИМ: подсевается сам ЛИБО реально матчится формой, в которой клиент шлёт машину", () => {
    // 🔴 ПЕРЕПИСАН ПОСЛЕ АДВЕРС-РЕВЬЮ. Прежняя версия обещала в комментарии ловить «мёртвый груз», а
    // проверяла лишь непустоту полей — и мутация это доказала: рецепт с заведомо не встречающимся
    // exe проходил молча. Теперь достижимость проверяется ПРОГОНОМ matchChannels на тех ДВУХ формах,
    // в которых клиент реально присылает машину: запись реестра установленного {name, exe|uri} и
    // детектированная PATH-команда {name: cmd, cli: true}.
    for (const r of CHANNEL_RECIPES) {
      if (r.builtin || r.service) continue; // такие подсеваются без матча — это отдельный контракт ниже
      const forms: Array<{ label: string; app: InstalledApp }> = [];
      const exe0 = r.exe?.[0];
      const uri0 = r.uri?.[0];
      // H-W1 (ревью 2026-09-24): ОБЩЕЕ имя exe (launcher.exe/browser.exe) одно программу не называет — реестр
      // даёт к нему настоящее имя программы, и матч идёт по паре «exe + имя». Форма с именем-заглушкой для
      // такого exe обязана НЕ находиться (иначе Rockstar Launcher снова стал бы HoYoPlay).
      if (exe0) forms.push({ label: `exe ${exe0}`, app: { name: isGenericExeName(exe0) ? r.app : "из реестра", exe: exe0 } });
      if (uri0) forms.push({ label: `uri ${uri0}`, app: { name: "схема", uri: uri0 } });
      if (r.cmd) forms.push({ label: `cmd ${r.cmd}`, app: { name: r.cmd, cli: true } });
      expect(forms.length, `${r.app}: нечем матчить вообще`).toBeGreaterThan(0);
      for (const f of forms) {
        const hit = matchChannels([f.app]).some((m) => m.app === r.app);
        expect(hit, `${r.app}: объявил «${f.label}», но matchChannels его так НЕ находит`).toBe(true);
      }
    }
  });

  it("🔴 системная утилита Windows обязана быть builtin — иначе её нет ни в реестре, ни на PATH", () => {
    // Живой случай (адверс-ревью): «Windows: буфер обмена» был единственным из пяти системных
    // рецептов БЕЗ builtin. clip.exe не бывает ни в списке установленных программ, ни среди URI-схем,
    // ни в каталоге детекта — значит рецепт был недостижим ПО ПОСТРОЕНИЮ, и на «что в буфере»
    // app_channels уверенно отвечал «канала нет, остаётся GUI» при живом канале.
    const SYSTEM_BINARIES = ["clip", "powercfg", "schtasks", "netsh", "powershell", "sc", "reg", "wmic", "displayswitch"];
    for (const r of CHANNEL_RECIPES) {
      const cmd = (r.cmd ?? "").toLowerCase();
      if (!SYSTEM_BINARIES.includes(cmd)) continue;
      expect(r.builtin === true, `${r.app}: cmd «${cmd}» — часть Windows, нужен builtin: true`).toBe(true);
    }
  });

  it("🔴 рецепт на PATH-команду не разойдётся с каталогом детекта клиента", () => {
    // Матч по `cmd` возможен, только если клиент ПРИСЛАЛ эту команду: либо детектом PATH (TOOL_SPECS
    // в apps/client/main/sensors/system-profiler.ts), либо записью реестра с таким exe. Ревью нашло
    // ровно этот разрыв: рецепты на python/nvidia-smi/pdftotext лежали в таблице, каталог их не знал,
    // и app_channels отвечал «канала нет» про то, что на машине есть. Тут сверяем два файла — иначе
    // расхождение снова уедет зелёным (наблюдать это поведение внутри серверных тестов нечем).
    const profiler = readFileSync(
      new URL("../../../client/main/sensors/system-profiler.ts", import.meta.url),
      "utf8",
    );
    const known = new Set([...profiler.matchAll(/cmd:\s*"([^"]+)"/g)].map((m) => (m[1] ?? "").toLowerCase()));
    expect(known.size, "не смог прочитать каталог детекта клиента").toBeGreaterThan(5);
    for (const r of CHANNEL_RECIPES) {
      if (!r.cmd || r.builtin || r.service) continue;
      if (r.exe?.length || r.uri?.length) continue; // найдётся записью реестра или схемой
      expect(
        known.has(r.cmd.toLowerCase()),
        `${r.app}: единственный способ найтись — cmd «${r.cmd}», но клиент такую команду не детектит (добавь в TOOL_SPECS)`,
      ).toBe(true);
    }
  });

  it("🔴 ни один рецепт не ведёт в ГАРАНТИРОВАННЫЙ отказ: browser_open не получает не-http схему", () => {
    // Живой дефект 2026-09-01: рецепты Windows-настроек, Steam, Telegram, Epic и Dota велели открывать
    // свой протокол через browser_open — а тот пропускает ТОЛЬКО http(s), и ms-settings:/steam://tg://
    // отвергаются SSRF-гардом ВСЕГДА. Это не «иногда не срабатывает», а стопроцентный отказ в рецепте,
    // который модель читает как проверенное знание. Сверяем ДАННЫЕ с НАСТОЯЩИМ гардом, а не с текстом:
    // при возврате старой формулировки тест обязан упасть.
    for (const r of CHANNEL_RECIPES) {
      for (const m of r.howTo.matchAll(/browser_open\{\s*url:\s*"([^"]+)"/g)) {
        const url = m[1]!;
        expect(
          browserUrlBlocked(url),
          `${r.app}: howTo велит открыть «${url}» через browser_open, но SSRF-гард эту схему отвергает — ` +
            `рецепт гарантирует отказ. Не-http схему открывает app_launch{app:"…"}.`,
        ).toBe(false);
      }
    }
  });

  it("имена рецептов уникальны", () => {
    // Дубль тихо съедается Map по имени: в таблице уже жили ДВА FFmpeg, и побеждал тот, что беднее
    // (у него не было exe — значит, по установленному он не находился вовсе).
    const names = CHANNEL_RECIPES.map((r) => r.app);
    expect(new Set(names).size, `дубли: ${names.filter((n, i) => names.indexOf(n) !== i).join(", ")}`).toBe(names.length);
  });
});

describe("🔴 РЕАЛЬНАЯ машина: рецепт на установленную программу обязан находиться", () => {
  // Самый сильный guard этого файла, и единственный, который ловит класс дефекта «exe объявлен, но
  // инвентарь его никогда не отдаёт». Синтетикой он НЕ ловится по построению: если строить список
  // установленного из самого рецепта, совпадение будет всегда. Поэтому здесь — СНЯТЫЙ С МАШИНЫ
  // владельца инвентарь (реальный вывод detectInstalledApps(), 303 записи).
  //
  // Что этот тест поймал живьём (адверс-ревью 2026-09-01): у Word/Excel в реестре установленного
  // DisplayIcon не .exe (у Word — osetup.dll), поэтому рецепты с одним лишь `exe: winword.exe`
  // не находились НИКОГДА, и на «допиши абзац в ворде» app_channels уверенно отвечал «канала нет —
  // остаётся GUI», разворачивая модель в самый дорогой путь мимо office_word. Лечится схемами
  // ms-word:/ms-excel:, которые в системе зарегистрированы.
  const inventory = JSON.parse(
    readFileSync(new URL("./__fixtures__/installed-real-machine.json", import.meta.url), "utf8"),
  ) as Array<{ name: string; exe?: string; uri?: string }>;

  it("фикстура — настоящий инвентарь, а не заглушка", () => {
    expect(inventory.length).toBeGreaterThan(100);
  });

  it.each([
    ["Microsoft Word", "ворд"],
    ["Microsoft Excel", "эксель"],
    ["Steam", "стим"],
    ["Telegram Desktop", "телеграм"],
    ["OBS Studio", "обс"],
    ["Документы без Office (Python)", "презентация"],
    ["Windows: настройки", "настройки"],
  ])("«%s» находится на реальной машине и по русскому запросу «%s»", (appName, query) => {
    const matched = matchChannels(inventory);
    expect(matched.map((m) => m.app), `${appName}: рецепт есть, программа на машине есть, а матча нет`).toContain(appName);
    const text = formatChannels(matched, query);
    expect(text, `запрос «${query}» получил ложное «канала нет»`).not.toMatch(/программного канала в реестре нет/);
  });

  it("встроенная утилита Windows отвечает на запрос владельца, хотя её нет в списке установленного", () => {
    // clip.exe не бывает ни в реестре установленного, ни среди URI-схем — только флагом builtin.
    const text = formatChannels(matchChannels(inventory), "буфер обмена");
    expect(text).not.toMatch(/программного канала в реестре нет/);
    expect(text).toContain("Get-Clipboard");
  });

  it("НЕустановленная программа честно отвечает «канала нет» (обратная сторона того же инварианта)", () => {
    // На этой машине нет 7-Zip и ImageMagick — и «канала нет» здесь ПРАВДА, а не дефект.
    // Без этой проверки предыдущие можно было бы «починить» тем, что находится вообще всё.
    const text = formatChannels(matchChannels(inventory), "фотошоп");
    expect(text).toMatch(/программного канала в реестре нет/);
  });
});

describe("поиск файлов по индексу Windows (замер: 588 213 файлов, fs_search 32 с и 3,4% дерева)", () => {
  it("достижим без единой установленной программы и находится по русскому «найди файл»", () => {
    // Индекс — часть Windows: в списке установленного его нет по определению, поэтому builtin.
    const text = formatChannels(matchChannels([]), "найди файл");
    expect(text, "рецепт недостижим: на «найди файл» ответ «канала нет»").not.toMatch(/программного канала в реестре нет/);
    expect(text).toContain("Search.CollatorDSO");
  });

  it("🔴 сверка учит отличать «папка не в индексе» от «файлов нет»", () => {
    // Проверено живьём на этой машине: C:\Program Files, C:\Windows и диск D: НЕ индексируются и
    // молча дают 0 строк — ровно тот случай, когда «ничего не нашёл» было бы ложью. Рецепт обязан
    // нести пробу покрытия и уход в обход, иначе он производит ложный отрицательный ответ.
    const r = CHANNEL_RECIPES.find((x) => x.app === "Windows: поиск файлов по индексу")!;
    expect(r.verify).toMatch(/SCOPE=/);
    expect(r.verify).toMatch(/fs_search/);
    expect(r.verify).toMatch(/Test-Path/);
    expect(r.verify).toMatch(/ОШИБК/); // сбой канала докладывается ошибкой, а не пустой выдачей
  });

  it("🔴 полнотекст честен: CONTAINS слеп для типов без IFilter (.md — проверено), ноль по содержимому ≠ содержимого нет", () => {
    // Живой прогон 2026-09-01: у .md на этой машине нет PersistentHandler — CONTAINS по нему ВСЕГДА 0
    // строк, хотя поиск по имени те же .md находит. Прежний текст обещал полнотекст для «txt/md/office/pdf»
    // — декларация расходилась с поведением, и модель рапортовала бы «в файлах этого нет». Второй факт
    // того же прогона: репозиторий jarvis ВНУТРИ профиля в индексе отсутствует при проиндексированных
    // соседях — проба покрытия обязательна всегда, не только для C:\Windows.
    const r = CHANNEL_RECIPES.find((x) => x.app === "Windows: поиск файлов по индексу")!;
    expect(r.limits).toMatch(/\.md — НЕТ/);
    expect(r.limits).not.toMatch(/txt\/md\/office/); // старая ложная декларация не должна вернуться
    expect(r.verify).toMatch(/CONTAINS ничего не нашёл ≠ содержимого нет/);
    expect(r.verify).toMatch(/inContent:true/); // назван честный путь при нуле по содержимому
    expect(r.verify).toMatch(/ВНУТРИ профиля/); // проба покрытия — не только для системных путей
  });
});

describe("сопоставление", () => {
  it("🔴 Blender находится в ТОЙ ФОРМЕ, в которой его теперь присылает клиент", () => {
    // Детект отдаёт ToolCap, а клиент кладёт его в инвентарь как {name: id, cli: true}
    // (apps/client/main/index.ts). Прежде Blender не доезжал вовсе: exe не на PATH и пустой
    // DisplayIcon в реестре — теперь его находит glob по версионному каталогу.
    const m = matchChannels([{ name: "blender", cli: true }]);
    expect(m.map((x) => x.app)).toContain("Blender");
  });


  it("по имени exe", () => {
    const m = matchChannels([app("Steam", "steam.exe")]);
    expect(m.map((x) => x.app)).toContain("Steam");
  });

  it("по URI-схеме (когда exe неизвестен — так бывает у половины записей реестра)", () => {
    const m = matchChannels([app("tg:", undefined, "tg")]);
    expect(m.map((x) => x.app)).toContain("Telegram Desktop");
  });

  it("путь к exe нормализуется (реестр отдаёт полные пути и разный регистр)", () => {
    expect(exeName("C:\\Program Files (x86)\\Steam\\Steam.EXE")).toBe("steam.exe");
    expect(recipeMatches(CHANNEL_RECIPES.find((r) => r.app === "Steam")!, app("x", "C:/x/STEAM.exe"))).toBe(true);
  });

  it("незнакомое приложение не даёт СВОИХ совпадений (остаётся только самопосев)", () => {
    const m = matchChannels([app("Какая-то программа", "zzz.exe")]);
    expect(m.every((x) => x.builtin === true || x.service === true)).toBe(true);
    expect(m.some((x) => x.installedAs === "Какая-то программа")).toBe(false);
  });

  it("встроенные утилиты Windows и сетевые сервисы доступны всегда — их нет в списке установленного", () => {
    const m = matchChannels([]);
    expect(m.some((x) => x.app.includes("планировщик"))).toBe(true);
    expect(m.some((x) => x.app.includes("ЦБ РФ"))).toBe(true);
    expect(m.every((x) => x.builtin === true || x.service === true)).toBe(true);
  });

  it("дубли схлопываются: одно приложение — один лучший канал", () => {
    const m = matchChannels([app("Steam", "steam.exe", "steam"), app("Steam (копия)", "steam.exe")]);
    expect(m.filter((x) => x.app === "Steam")).toHaveLength(1);
  });

  it("помнит, как приложение названо НА ЭТОЙ машине", () => {
    const m = matchChannels([app("Telegram Desktop 5.7", "telegram.exe")]);
    expect(m.find((x) => x.app === "Telegram Desktop")?.installedAs).toBe("Telegram Desktop 5.7");
  });
});

describe("русский запрос находит латинское имя", () => {
  it("«дискорд» находит Discord — иначе ответ «канала нет» звал бы искать запрещённый API", () => {
    const text = formatChannels(matchChannels([app("Discord", "discord.exe")]), "дискорд");
    expect(text).toMatch(/self-bot/i);
  });

  it("«стим» находит Steam", () => {
    expect(formatChannels(matchChannels([app("Steam", "steam.exe")]), "стим")).toContain("Steam");
  });
});

describe("честность сводки", () => {
  it("🔴 «канала НЕТ» не выдаётся за наличие канала", () => {
    const s = channelSummary(matchChannels([app("Discord", "discord.exe")]));
    expect(s).not.toContain("есть у: Discord");
    expect(s === "" || /канала НЕТ/.test(s)).toBe(true);
  });

  it("при смеси — в списке только рабочие каналы, про остальные честная приписка", () => {
    const s = channelSummary(matchChannels([app("Steam", "steam.exe"), app("Discord", "discord.exe")]));
    expect(s).toContain("Steam");
    expect(s).toContain("канала НЕТ");
  });

  it("в сводке нет незнакомого приложения (мусор в паспорт не идёт)", () => {
    expect(channelSummary(matchChannels([app("Незнакомое", "zzz.exe")]))).not.toContain("Незнакомое");
  });

  it("пустой вход вообще (не Windows-машина) — пустая сводка", () => {
    expect(channelSummary([])).toBe("");
  });

  it("🔴 приложения владельца НЕ вытесняются из сводки утилитами и сервисами", () => {
    // Сортировка идёт по типу канала, а cli — первый. После наполнения таблицы (2026-09-01) системных
    // утилит и сетевых сервисов стало больше восьми: без приоритета они заняли бы весь список имён, и
    // паспорт перестал бы называть то, ради чего он нужен — программы, установленные у владельца.
    const s = channelSummary(matchChannels([app("OBS Studio", "obs64.exe"), app("Blender", "blender.exe")]));
    expect(s).toContain("OBS Studio");
    expect(s).toContain("Blender");
  });

  it("сетевые сервисы названы, а не спрятаны в счётчик — иначе про курс валют никто не спросит", () => {
    const s = channelSummary(matchChannels([]));
    expect(s).toMatch(/сетевых сервисов \d+ \(/);
    expect(s).toMatch(/встроенных утилит Windows: \d+/);
  });
});

describe("выдача модели", () => {
  it("рецепт содержит все три части: как, чем сверить, чего не умеет", () => {
    const text = formatChannels(matchChannels([app("Steam", "steam.exe")]));
    expect(text).toContain("КАК:");
    expect(text).toContain("СВЕРКА ИСХОДА:");
    expect(text).toContain("ГРАНИЦЫ:");
  });

  it("запрос про приложение без рецепта отвечает ЧЕСТНО, а не молчанием", () => {
    const text = formatChannels(matchChannels([app("Steam", "steam.exe")]), "фотошоп");
    expect(text).toMatch(/нет/i);
    expect(text).toMatch(/GUI/);
  });

  it("для Discord отдаётся знание «не ищи API и не делай self-bot»", () => {
    const text = formatChannels(matchChannels([app("Discord", "discord.exe")]), "discord");
    expect(text).toMatch(/self-bot/i);
    expect(text).toMatch(/бану/i);
  });
});

describe("W4.2: рецепты для частых программ владельца + минуты фокуса", () => {
  const inventory = JSON.parse(
    readFileSync(new URL("./__fixtures__/installed-real-machine.json", import.meta.url), "utf8"),
  ) as Array<{ name: string; exe?: string; uri?: string }>;
  // Клиент присылает и PATH-команды (detectAutomationTools) — на машине владельца git/gh/ollama/psql найдены живьём.
  const withCli: InstalledApp[] = [...inventory, { name: "git", cli: true }, { name: "gh", cli: true }, { name: "ollama", cli: true }, { name: "psql", cli: true }];

  it("🔴 у КАЖДОЙ программы из сида есть рецепт, и он НАХОДИТСЯ на реальной машине (или это встроенная утилита)", () => {
    const matched = matchChannels(withCli);
    const names = new Set(matched.map((m) => m.app));
    for (const app of TOP_APPS_SEED) {
      const r = CHANNEL_RECIPES.find((x) => x.app === app);
      expect(r, `${app}: рецепта нет`).toBeDefined();
      expect(names.has(app), `${app}: рецепт есть, но на реальной машине не находится`).toBe(true);
    }
    expect(TOP_APPS_SEED.length).toBe(20);
  });

  it("новые рецепты честны: у CapCut/VPN канала НЕТ и они не попадают в строку «каналы есть у»", () => {
    const matched = matchChannels(withCli);
    const line = channelSummary(matched);
    expect(line).not.toMatch(/CapCut|Hiddify/u);
    expect(matched.find((m) => m.app === "CapCut")?.kind).toBe("none");
  });

  it("channelForProcess: obs64 → OBS Studio (по exe), chrome → Google Chrome, Telegram → Telegram Desktop, Claude → нет", () => {
    const matched = matchChannels(withCli);
    expect(channelForProcess("obs64", matched)?.app).toBe("OBS Studio");
    expect(channelForProcess("chrome", matched)?.app).toBe("Google Chrome");
    expect(channelForProcess("Telegram", matched)?.app).toBe("Telegram Desktop");
    expect(channelForProcess("Claude", matched)).toBeUndefined();
  });

  it("минуты фокуса упорядочивают паспорт: программа с большим фокусом идёт первой; покрытие называет «канала нет»", () => {
    const matched = matchChannels(withCli);
    const usage = sanitizeUsage([{ process: "Telegram", minutes: 25, days: 3 }, { process: "chrome", minutes: 173, days: 3 }, { process: "Claude", minutes: 38, days: 3 }]);
    const line = channelSummary(matched, usage);
    expect(line.indexOf("Google Chrome")).toBeGreaterThan(-1);
    expect(line.indexOf("Google Chrome")).toBeLessThan(line.indexOf("Telegram Desktop"));
    const cov = formatUsageCoverage(usage, matched);
    expect(cov).toMatch(/chrome — 173 мин: Google Chrome — канал cli/u);
    expect(cov).toMatch(/Claude — 38 мин: канала нет/u);
    expect(cov).toMatch(/за 3 дн\./u);
  });

  it("sanitizeUsage: мусор отбрасывается, строки капнуты, не больше 30", () => {
    const out = sanitizeUsage([{ process: " x ".padEnd(80, "y"), minutes: 1.6, days: 2 }, { process: "", minutes: 1, days: 1 }, { process: "z", minutes: "1" }, null, ...Array.from({ length: 40 }, (_, i) => ({ process: `p${i}`, minutes: i, days: 1 }))]);
    expect(out.length).toBe(30);
    expect(out[0]).toEqual({ process: " x ".padEnd(80, "y").trim().slice(0, 48), minutes: 2, days: 2 });
    expect(sanitizeUsage("nope")).toEqual([]);
  });
});

// H-W1 (ревью 2026-09-24): покрытие частых программ W4.2 врало в обе стороны — встроенные проводник/блокнот/
// терминал шли «канала нет → GUI», а Rockstar Games Launcher (Launcher.exe) записывался в HoYoPlay.
// Реверт-проверки: убрать exe у встроенных → падает первый кейс; убрать гард общего имени в recipeMatches /
// channelForProcess → падают второй и третий.
describe("H-W1: процесс переднего окна → канал (встроенные программы, общие имена exe)", () => {
  it("проводник, блокнот и терминал — встроенные каналы, а не «канала нет → GUI»", () => {
    const matched = matchChannels([]);
    expect(channelForProcess("explorer", matched)?.app).toBe("Windows: проводник");
    expect(channelForProcess("notepad", matched)?.app).toBe("Windows: блокнот");
    for (const p of ["WindowsTerminal", "cmd", "powershell", "pwsh"]) expect(channelForProcess(p, matched)?.app, p).toBe("Windows: терминал / cmd");
    const cov = formatUsageCoverage(sanitizeUsage([{ process: "explorer", minutes: 60, days: 2 }, { process: "WindowsTerminal", minutes: 20, days: 2 }]), matched);
    expect(cov).toMatch(/explorer — 60 мин: Windows: проводник — канал cli/u);
    expect(cov).toMatch(/WindowsTerminal — 20 мин: Windows: терминал \/ cmd — канал cli/u);
    expect(cov).not.toMatch(/канала нет/u);
  });

  it("Rockstar Games Launcher (launcher.exe) НЕ становится HoYoPlay; сам HoYoPlay — по имени из реестра находится", () => {
    expect(matchChannels([app("Rockstar Games Launcher", "launcher.exe")]).some((m) => m.app.startsWith("HoYoPlay"))).toBe(false);
    expect(matchChannels([app("HoYoPlay", "launcher.exe")]).some((m) => m.app.startsWith("HoYoPlay"))).toBe(true);
    expect(matchChannels([app("Some Browser", "browser.exe")]).some((m) => m.app === "Yandex Browser")).toBe(false);
    expect(matchChannels([app("Yandex (All Users)", "browser.exe")]).some((m) => m.app === "Yandex Browser")).toBe(true);
  });

  it("процесс с общим именем («Launcher») канал не угадывает — и покрытие говорит это прямо", () => {
    const matched = matchChannels([app("HoYoPlay", "launcher.exe"), app("Rockstar Games Launcher", "launcher.exe")]);
    expect(channelForProcess("Launcher", matched)).toBeUndefined();
    expect(channelForProcess("browser", matched)).toBeUndefined();
    const cov = formatUsageCoverage(sanitizeUsage([{ process: "Launcher", minutes: 90, days: 3 }]), matched);
    expect(cov).toMatch(/Launcher — 90 мин: общее имя процесса/u);
    expect(cov).not.toMatch(/HoYoPlay/u);
  });
});
