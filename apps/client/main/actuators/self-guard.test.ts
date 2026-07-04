import { describe, expect, it } from "vitest";
import { assertReadable, assertWritable, isProtectedSelfPath, isSecretPath } from "./self-guard.js";

// § рельсы самомодификации: Джарвис правит ИСХОДНИКИ, но не может перезаписать критичное для себя.
describe("self-guard — рельсы самомодификации", () => {
  it("node_modules — запись/удаление запрещены", () => {
    expect(isProtectedSelfPath("C:/proj/node_modules/foo/index.js")).toBe(true);
    expect(() => assertWritable("C:/proj/node_modules/x.js")).toThrow(/самосохранн/i);
  });

  it(".env — секрет: запрещены и запись, и чтение в контекст модели (§0)", () => {
    expect(isSecretPath("C:/proj/.env")).toBe(true);
    expect(isSecretPath("C:/proj/.env.local")).toBe(true);
    expect(() => assertWritable("C:/proj/.env")).toThrow();
    expect(() => assertReadable("C:/proj/.env")).toThrow(/секрет/i);
  });

  it("§sec расширенный denylist секретов: ключи/мастер-ключ/креды/cookie БД — read+write запрещены (M9/H4)", () => {
    for (const s of [
      "C:/Users/anton/.ssh/id_rsa",
      "C:/Users/anton/Desktop/id_rsa",
      "C:/proj/apps/server/data/credentials-master.key",
      "C:/certs/server.pem",
      "C:/certs/private.key",
      "C:/Users/anton/.aws/credentials",
      "C:/Users/anton/AppData/Local/Google/Chrome/User Data/Default/Login Data",
      "C:/Users/anton/.npmrc",
    ]) {
      expect(isSecretPath(s)).toBe(true);
      expect(() => assertReadable(s)).toThrow(/секрет/i);
      expect(() => assertWritable(s)).toThrow();
    }
    // Обычные файлы — НЕ секреты (без ложных срабатываний).
    expect(isSecretPath("C:/proj/notes.txt")).toBe(false);
    expect(isSecretPath("C:/proj/apps/server/src/keymap.ts")).toBe(false);
  });

  it("ИСХОДНИКИ разрешены — их и надо менять для самоулучшения", () => {
    const src = "C:/proj/apps/server/src/brain/agent/index.ts";
    expect(isProtectedSelfPath(src)).toBe(false);
    expect(() => assertWritable(src)).not.toThrow();
    expect(() => assertReadable(src)).not.toThrow();
  });

  it("критичные бинари по имени — защищены", () => {
    expect(isProtectedSelfPath("C:/x/SidecarWin.exe")).toBe(true);
    expect(isProtectedSelfPath("C:/x/electron.exe")).toBe(true);
    expect(isProtectedSelfPath("C:/x/node.exe")).toBe(true);
  });

  it("запущенный бинарь (process.execPath) защищён", () => {
    expect(isProtectedSelfPath(process.execPath)).toBe(true);
  });
});
