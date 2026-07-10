import { beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Мокаем electron: userData недоступен (как в тесте мониторов) + поддельный safeStorage,
// у которого «шифрование» = префикс enc:, а доступность шифрования переключается через state.
const h = vi.hoisted(() => {
  const state = { encAvail: true };
  return {
    state,
    safe: {
      isEncryptionAvailable: () => state.encAvail,
      encryptString: (s: string) => Buffer.from("enc:" + s, "utf8"),
      decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
    },
  };
});
vi.mock("electron", () => ({
  app: { getPath: () => { throw new Error("no userData in test"); } },
  safeStorage: h.safe,
}));

import { SettingsStore } from "./settings-store.js";

let c = 0;
const tmpCfg = (): string => join(tmpdir(), `jarvis-set-${process.pid}-${Date.now()}-${c++}.json`);

beforeEach(() => {
  h.state.encAvail = true;
});

describe("SettingsStore — персист настроек (язык/контекст/ключи)", () => {
  it("дефолты при отсутствии файла", () => {
    const s = new SettingsStore(tmpCfg());
    const snap = s.snapshot();
    expect(snap.language).toBe("ru");
    expect(snap.context).toBe("");
    expect(snap.keys).toEqual({ anthropic: false, eleven: false, deepgram: false });
  });

  it("сохраняет язык/контекст и переживает рестарт", () => {
    const cfg = tmpCfg();
    const s = new SettingsStore(cfg);
    const res = s.save({ language: "en", context: "Зовут Антон. На «ты»." });
    expect(res.ok).toBe(true);
    expect(s.snapshot().language).toBe("en");
    expect(s.snapshot().context).toBe("Зовут Антон. На «ты».");
    // новый стор той же конфигурации — значения на месте
    const s2 = new SettingsStore(cfg);
    expect(s2.snapshot().language).toBe("en");
    expect(s2.snapshot().context).toBe("Зовут Антон. На «ты».");
  });

  it("шифрует ключ, getKey расшифровывает, пустое поле не затирает, переживает рестарт", () => {
    const cfg = tmpCfg();
    const s = new SettingsStore(cfg);
    const res = s.save({ keys: { anthropic: "sk-secret" } });
    expect(res.ok).toBe(true);
    expect(res.keysStored).toEqual(["anthropic"]);
    expect(res.keysSkipped).toBe(false);
    expect(s.snapshot().keys).toEqual({ anthropic: true, eleven: false, deepgram: false });
    expect(s.getKey("anthropic")).toBe("sk-secret");
    // пустой патч ключей — НЕ затирает уже сохранённый
    s.save({ keys: { anthropic: "  " }, context: "x" });
    expect(s.snapshot().keys.anthropic).toBe(true);
    // переживает рестарт (шифр на диске → расшифровка тем же моком)
    const s2 = new SettingsStore(cfg);
    expect(s2.snapshot().keys.anthropic).toBe(true);
    expect(s2.getKey("anthropic")).toBe("sk-secret");
  });

  it("без ОС-шифрования: ключ НЕ сохраняется (keysSkipped), но язык пишется", () => {
    h.state.encAvail = false;
    const s = new SettingsStore(tmpCfg());
    const res = s.save({ language: "en", keys: { eleven: "voiceX" } });
    expect(res.ok).toBe(true);
    expect(res.encryptionAvailable).toBe(false);
    expect(res.keysSkipped).toBe(true);
    expect(res.keysStored).toEqual([]);
    expect(s.snapshot().keys.eleven).toBe(false); // секрет в plaintext не пишем
    expect(s.snapshot().language).toBe("en"); // не-секретное сохранилось
    expect(s.getKey("eleven")).toBeUndefined();
  });
});
