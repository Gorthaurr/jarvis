import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { obsAuthSecret } from "./obs.js";

// obs-websocket v5 auth: base64(sha256(base64(sha256(password+salt))+challenge)).
// Живой раунд-трип к OBS тут не проверить — фиксируем алгоритм (его правильность видно на живом OBS).
describe("obs-websocket v5 — строка аутентификации", () => {
  it("детерминирована и зависит от КАЖДОГО входа", () => {
    const a = obsAuthSecret("pw", "salt", "chal");
    expect(obsAuthSecret("pw", "salt", "chal")).toBe(a);
    expect(obsAuthSecret("pw2", "salt", "chal")).not.toBe(a);
    expect(obsAuthSecret("pw", "salt2", "chal")).not.toBe(a);
    expect(obsAuthSecret("pw", "salt", "chal2")).not.toBe(a);
  });

  it("совпадает с формулой base64(sha256(base64(sha256(pw+salt))+challenge))", () => {
    const pw = "supersecret";
    const salt = "c2FsdHNhbHQ=";
    const chal = "Y2hhbGxlbmdl";
    const b1 = createHash("sha256").update(pw + salt).digest("base64");
    const expected = createHash("sha256").update(b1 + chal).digest("base64");
    expect(obsAuthSecret(pw, salt, chal)).toBe(expected);
  });

  it("результат — base64 от 32 байт sha256 (44 символа, padding '=')", () => {
    expect(obsAuthSecret("a", "b", "c")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  // ОФИЦИАЛЬНЫЙ тест-вектор из доки obs-websocket (docs/generated/protocol.md) — доказывает,
  // что наша строка совпадёт с тем, что ждёт реальный сервер OBS.
  it("совпадает с официальным тест-вектором obs-websocket", () => {
    const auth = obsAuthSecret(
      "supersecretpassword",
      "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=",
      "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=",
    );
    expect(auth).toBe("1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=");
  });
});
