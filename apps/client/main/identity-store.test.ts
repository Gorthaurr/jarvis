import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// userData недоступен в тесте → конструктор падает в cwd-фолбэк (но мы передаём явный путь).
vi.mock("electron", () => ({
  app: {
    getPath: () => {
      throw new Error("no userData in test");
    },
  },
}));

import { IdentityStore } from "./identity-store.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let c = 0;
const tmpFile = (): string => join(tmpdir(), `jarvis-id-${process.pid}-${Date.now()}-${c++}.json`);

describe("IdentityStore — per-install UUID (§6B/B2)", () => {
  afterEach(() => {
    delete process.env.JARVIS_CLIENT_IDENTITY;
  });

  it("опт-ин ВЫКЛЮЧЕН (дефолт) → undefined (клиент шлёт dev-token, раздел не теряется)", () => {
    delete process.env.JARVIS_CLIENT_IDENTITY;
    const f = tmpFile();
    const s = new IdentityStore(f);
    expect(s.getOrCreateInstallId()).toBeUndefined();
    expect(existsSync(f)).toBe(false); // ничего не создаём
  });

  it("JARVIS_CLIENT_IDENTITY=1 → генерит UUID, персистит, стабилен между вызовами и «рестартами»", () => {
    process.env.JARVIS_CLIENT_IDENTITY = "1";
    const f = tmpFile();
    const s = new IdentityStore(f);
    const id1 = s.getOrCreateInstallId();
    expect(id1).toMatch(UUID_RE);
    expect(existsSync(f)).toBe(true);
    expect((JSON.parse(readFileSync(f, "utf8")) as { installId: string }).installId).toBe(id1);
    expect(s.getOrCreateInstallId()).toBe(id1); // кеш
    // новый стор той же конфигурации читает с диска тот же id (переживает рестарт клиента)
    expect(new IdentityStore(f).getOrCreateInstallId()).toBe(id1);
    rmSync(f, { force: true });
  });

  it("повреждённый файл → генерит новый id, не бросает", () => {
    process.env.JARVIS_CLIENT_IDENTITY = "1";
    const f = tmpFile();
    writeFileSync(f, "{ broken json", "utf8");
    const id = new IdentityStore(f).getOrCreateInstallId();
    expect(id).toMatch(UUID_RE);
    rmSync(f, { force: true });
  });
});
