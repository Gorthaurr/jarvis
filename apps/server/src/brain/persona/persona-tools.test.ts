/**
 * W1 (L-7, B-11): персона уходит в КАЖДЫЙ запрос — и учила несуществующему инструменту (`read.window`), и старым
 * именам/холодным инструментам как горячим (`browser_batch` «если доступен», `browser_close`). Страж:
 *  1) каждый инструмент, названный в персоне или в общих навыках (`имя` в обратных кавычках с `_`/`.` или вызов
 *     `имя{…}`), существует в @jarvis/tools (схема или фасад);
 *  2) холодный инструмент (COLD_TOOL_NAMES), названный в абзаце персоны, стоит рядом со словом tool_load в том же
 *     абзаце — иначе модель зовёт его как горячий (на подписке его нет в наборе — вызов падает).
 * Ожидания — через TOOLS_BY_NAME/COLD_TOOL_NAMES, без списков горячих: страж верен и после переноса инструмента
 * между горячими и холодными (W1: browser_batch → горячий, browser_close → холодный алиас browser_tabs{op:"close"}).
 * Реверт: верни в персону `read.window` — упадёт (1); убери «tool_load» из абзаца про мониторы — упадёт (2).
 */
import { readFileSync } from "node:fs";
import { COLD_TOOL_NAMES, FACADE_TOOL_NAMES, TOOLS_BY_NAME } from "@jarvis/tools";
import { describe, expect, it } from "vitest";
import { SHARED_SKILL_SEED } from "../../seed/shared-skills.js";

const PERSONA = readFileSync(new URL("./persona.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Идентификаторы в обратных кавычках, которые НЕ инструменты (параметры, значения, API макроса) — с причиной. */
const NOT_TOOLS: Record<string, string> = {
  "condition.kind": "поле условия wait_for",
  moex_fut: "значение параметра market",
  crypto_fut: "значение параметра market",
  delay_seconds: "параметр set_reminder",
  id_rsa: "имя файла ключа (секреты не читаем)",
  "g.key": "вызов pydirectinput в своём макросе",
  tab_not_visible: "код ответа расширения (снимок неактивной вкладки)",
  secret_field: "код ответа расширения (поле пароля/кода/карты)",
};
const FILE_RE = /\.(py|cfg|json|md|txt|ts|js|pem|key|exe|ps1|bat)$/u;

const isTool = (n: string): boolean => n in TOOLS_BY_NAME || FACADE_TOOL_NAMES.has(n);

/** Упомянутые инструменты текста: `snake_case`/`dotted` в кавычках (голова спана) и вызовы `имя{…}` вне их. */
function mentionedTools(text: string): string[] {
  const out = new Set<string>();
  for (const [, span] of text.matchAll(/`([^`\n]+)`/gu)) {
    const family = /^([a-z]+_)\*/u.exec(span!);
    if (family) {
      out.add(`${family[1]}*`);
      continue;
    }
    const head = /^([a-z][a-z0-9]*(?:[_.][a-z0-9]+)+)(?=$|[{(\s,:])/u.exec(span!)?.[1];
    if (head && !FILE_RE.test(head)) out.add(head);
  }
  for (const [, name] of text.matchAll(/(?<![\w.$'"-])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\{/gu)) out.add(name!);
  return [...out];
}

function unknownTools(text: string): string[] {
  return mentionedTools(text).filter((n) => {
    if (n in NOT_TOOLS || isTool(n)) return false;
    if (n.endsWith("_*")) return !Object.keys(TOOLS_BY_NAME).some((t) => t.startsWith(n.slice(0, -1)));
    return true;
  });
}

/** Холодные инструменты, названные в абзаце БЕЗ слова tool_load в том же абзаце (модель позвала бы их как горячие). */
function coldWithoutLoad(text: string): string[] {
  const offenders: string[] = [];
  text.split(/\n\s*\n/u).forEach((block, i) => {
    if (/tool_load/u.test(block)) return;
    for (const name of COLD_TOOL_NAMES) {
      if (new RegExp(`(^|[^\\w])${name}([^\\w]|$)`, "u").test(block)) offenders.push(`абзац ${i + 1}: ${name}`);
    }
  });
  return offenders;
}

describe("персона и общие навыки учат только существующим инструментам", () => {
  it("персона: каждый названный инструмент есть в @jarvis/tools (ни `read.window`, ни устаревших имён)", () => {
    expect(unknownTools(PERSONA)).toEqual([]);
  });

  it("общие навыки: каждый вызываемый/названный инструмент есть в @jarvis/tools", () => {
    const bad = SHARED_SKILL_SEED.flatMap((md) => unknownTools(md).map((n) => `${/id: (\S+)/u.exec(md)?.[1]}: ${n}`));
    expect(bad).toEqual([]);
  });

  it("персона: холодный инструмент назван только рядом с tool_load (в том же абзаце)", () => {
    expect(coldWithoutLoad(PERSONA)).toEqual([]);
  });

  it("сам страж ловит несуществующий и холодный-без-tool_load (проверка на подложном тексте)", () => {
    expect(unknownTools("смотри `read.window` и `browser_read`")).toEqual(["read.window"]);
    expect(unknownTools("вызови nope_tool{x:1} и `input_*`")).toEqual(["nope_tool"]);
    // W1-ревью T11: подложка гоняется ЧЕРЕЗ сам страж (не тавтология по строке): без tool_load — ловит, с ним — нет;
    // пометка в СОСЕДНЕМ абзаце не спасает (граница — пустая строка).
    const cold = [...COLD_TOOL_NAMES][0]!;
    expect(coldWithoutLoad(`Вступление.\n\nАбзац про \`${cold}\` — зови прямо.`)).toEqual([`абзац 2: ${cold}`]);
    expect(coldWithoutLoad(`Абзац про \`${cold}\`: сначала tool_load{names:["${cold}"]}.`)).toEqual([]);
    expect(coldWithoutLoad(`Про tool_load.\n\nАбзац про \`${cold}\`.`)).toEqual([`абзац 2: ${cold}`]);
  });
});
