import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResolutionMemory, loadResolutionMemory, readPersisted, writePersisted } from "./resolution-memory.js";

const U = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";

describe("ResolutionMemory — опытная память резолва (§6B/B3: ключ с userId)", () => {
  it("remember → recall (peerId/title), hits растут", () => {
    const m = new ResolutionMemory(() => 1000);
    m.remember(U, "telegram", "Герман", { peerId: "8509637953", title: "Herman" });
    const e = m.recall(U, "telegram", "Герман");
    expect(e?.peerId).toBe("8509637953");
    expect(e?.title).toBe("Herman");
    expect(e?.hits).toBe(1);
    m.remember(U, "telegram", "Герман", { peerId: "8509637953", title: "Herman" });
    expect(m.recall(U, "telegram", "Герман")?.hits).toBe(2);
  });

  it("РАЗНЫЕ userId НЕ видят резолвы друг друга — фикс «Катя уходит не тому»", () => {
    const m = new ResolutionMemory(() => 1);
    m.remember(U, "telegram", "Катя", { peerId: "111", title: "Катя (девушка U1)" });
    m.remember(U2, "telegram", "Катя", { peerId: "222", title: "Катя (коллега U2)" });
    expect(m.recall(U, "telegram", "Катя")?.peerId).toBe("111"); // каждый видит СВОЙ резолв
    expect(m.recall(U2, "telegram", "Катя")?.peerId).toBe("222");
    // забывание у одного не трогает другого
    m.forget(U, "telegram", "Катя");
    expect(m.recall(U, "telegram", "Катя")).toBeUndefined();
    expect(m.recall(U2, "telegram", "Катя")?.peerId).toBe("222");
  });

  it("ключ свёрнут (регистр/пробелы): «  герман » попадает в «Герман»", () => {
    const m = new ResolutionMemory(() => 1);
    m.remember(U, "telegram", "Герман", { peerId: "1", title: "Herman" });
    expect(m.recall(U, "telegram", "  герман ")?.peerId).toBe("1");
  });

  it("другой канал/неизвестный запрос → промах", () => {
    const m = new ResolutionMemory(() => 1);
    m.remember(U, "telegram", "Герман", { peerId: "1", title: "Herman" });
    expect(m.recall(U, "vk", "Герман")).toBeUndefined();
    expect(m.recall(U, "telegram", "Светлана")).toBeUndefined();
  });

  it("forget (self-heal) убирает запись", () => {
    const m = new ResolutionMemory(() => 1);
    m.remember(U, "telegram", "Герман", { peerId: "1", title: "Herman" });
    m.forget(U, "telegram", "Герман");
    expect(m.recall(U, "telegram", "Герман")).toBeUndefined();
  });

  it("TTL: протухшая запись не возвращается", () => {
    let now = 1000;
    const m = new ResolutionMemory(() => now);
    m.remember(U, "telegram", "Герман", { peerId: "1", title: "Herman" });
    now += 181 * 24 * 60 * 60 * 1000; // > 180 дней
    expect(m.recall(U, "telegram", "Герман")).toBeUndefined();
  });

  it("мусор (пустой title/query/userId) не запоминается — иначе ложный fast-path", () => {
    const m = new ResolutionMemory(() => 1);
    m.remember(U, "telegram", "Герман", { title: "  " });
    m.remember(U, "telegram", "  ", { title: "Herman" });
    m.remember("", "telegram", "Герман", { title: "Herman" });
    expect(m.size).toBe(0);
  });

  it("peerId не теряется при повторном remember без него (берём прежний)", () => {
    const m = new ResolutionMemory(() => 1);
    m.remember(U, "telegram", "Герман", { peerId: "8509637953", title: "Herman" });
    m.remember(U, "telegram", "Герман", { title: "Herman" }); // повтор без peerId
    expect(m.recall(U, "telegram", "Герман")?.peerId).toBe("8509637953");
  });
});

describe("ResolutionMemory — персист на диск", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-resmem-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("write→read round-trip", () => {
    const m = new ResolutionMemory(() => 5);
    m.remember(U, "telegram", "Герман", { peerId: "1", title: "Herman" });
    writePersisted(dir, m.toJSON());
    const entries = readPersisted(dir);
    expect(entries).toHaveLength(1);
    expect(entries![0]!.peerId).toBe("1");
    expect(entries![0]!.userId).toBe(U); // userId персистится
  });

  it("loadResolutionMemory восстанавливает свежие и автосохраняет", () => {
    const m1 = new ResolutionMemory(() => 5);
    m1.remember(U, "telegram", "Катя", { peerId: "1882429334", title: "Катя Любимая" });
    writePersisted(dir, m1.toJSON());
    const m2 = loadResolutionMemory(() => 6, dir);
    expect(m2.recall(U, "telegram", "Катя")?.peerId).toBe("1882429334");
  });

  it("континьюити: старая запись без userId → раздел dev (существующий resolutions.json цел)", () => {
    const DEV = "00000000-0000-0000-0000-000000000001";
    // эмулируем legacy-снимок (до B3) — без поля userId
    const legacy = [{ channel: "telegram", queryFold: "german", queryRaw: "Герман", peerId: "9", title: "Herman", hits: 1, lastAt: 5 }];
    writePersisted(dir, { entries: legacy as never });
    const m = loadResolutionMemory(() => 6, dir);
    expect(m.recall(DEV, "telegram", "Герман")?.peerId).toBe("9"); // прочитано в раздел dev
  });

  it("битый/отсутствующий файл → пустая память без падения", () => {
    expect(readPersisted(dir)).toBeNull();
    const m = loadResolutionMemory(() => 1, dir);
    expect(m.size).toBe(0);
  });
});
