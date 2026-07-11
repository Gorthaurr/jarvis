/**
 * §Волна3 ревью (#9/#10) — безопасность и границы GSI-листенера. Листенер включён по умолчанию
 * (127.0.0.1:JARVIS_GSI_PORT), поэтому браузерный CSRF/DNS-rebinding и неограниченный рост памяти —
 * реальные векторы. Поднимаем на тестовом порту и бьём HTTP-запросами.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { request } from "node:http";

const PORT = 37319;
process.env.JARVIS_GSI_PORT = String(PORT);

// eslint-disable-next-line @typescript-eslint/no-var-requires -- динамический импорт после установки env
let mod: typeof import("./gsi-listener.js");

interface Resp {
  status: number;
}
function post(path: string, body: string, headers: Record<string, string>): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: PORT, path, method: "POST", headers: { "content-length": Buffer.byteLength(body), ...headers } },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const JSON_HDR = { "content-type": "application/json" };

beforeAll(async () => {
  mod = await import("./gsi-listener.js");
  mod.startGsiListener();
  await new Promise((r) => setTimeout(r, 100));
});
afterAll(() => mod.stopGsiListener());

describe("GSI-листенер: безопасность (#9)", () => {
  it("легитимный локальный пуш (json, без Origin) принимается и читается", async () => {
    const r = await post("/dota", JSON.stringify({ map: { game_state: "IN_PROGRESS" } }), JSON_HDR);
    expect(r.status).toBe(200);
    const got = mod.gsiValue("dota", "map.game_state");
    expect(got?.value).toBe("IN_PROGRESS");
  });

  it("запрос с Origin (браузерный fetch/CSRF) отвергается 403", async () => {
    const r = await post("/dota", JSON.stringify({ x: 1 }), { ...JSON_HDR, origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  it("чужой Host (DNS-rebinding) отвергается 403", async () => {
    const r = await post("/dota", JSON.stringify({ x: 1 }), { ...JSON_HDR, host: "evil.example" });
    expect(r.status).toBe(403);
  });

  it("не-JSON Content-Type отвергается 415", async () => {
    const r = await post("/dota", "x=1", { "content-type": "text/plain" });
    expect(r.status).toBe(415);
  });

  it("GET/preflight (не POST) → 405 без CORS-заголовков", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: PORT, path: "/dota", method: "GET" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(405);
  });
});

describe("GSI-листенер: границы памяти (#10)", () => {
  it("число источников ограничено — старейшие вытесняются, роста без предела нет", async () => {
    for (let i = 0; i < 50; i += 1) {
      await post(`/src${i}`, JSON.stringify({ n: i }), JSON_HDR);
    }
    // Ранние источники вытеснены (кап 32), поздние — на месте.
    expect(mod.gsiValue("src0", "n")).toBeNull();
    expect(mod.gsiValue("src49", "n")?.value).toBe(49);
  });
});

describe("GSI-листенер: токен (#9, ревью фиксов #5) — гард бьётся живыми запросами", () => {
  afterEach(() => {
    delete process.env.JARVIS_GSI_TOKEN; // токен читается per-request → env-скоуп на тест
  });

  it("токен задан: пуш без токена/с неверным → 401, state НЕ обновлён; с верным → 200", async () => {
    process.env.JARVIS_GSI_TOKEN = "sekret-123";
    expect((await post("/tok", JSON.stringify({ v: "no-token" }), JSON_HDR)).status).toBe(401);
    expect((await post("/tok", JSON.stringify({ v: "bad", auth: { token: "wrong" } }), JSON_HDR)).status).toBe(401);
    expect(mod.gsiValue("tok", "v")).toBeNull(); // отвергнутые пуши в стор не попали
    const okResp = await post("/tok", JSON.stringify({ v: "ok", auth: { token: "sekret-123" } }), JSON_HDR);
    expect(okResp.status).toBe(200);
    expect(mod.gsiValue("tok", "v")?.value).toBe("ok");
  });

  it("(#4) auth в стор не сохраняется — токен не читаем через path и не утекает в detail/логи", async () => {
    process.env.JARVIS_GSI_TOKEN = "sekret-123";
    await post("/tok2", JSON.stringify({ v: 1, auth: { token: "sekret-123" } }), JSON_HDR);
    expect(mod.gsiValue("tok2", "auth.token")?.value).toBeUndefined();
    expect(mod.gsiValue("tok2", "auth")?.value).toBeUndefined();
    expect(mod.gsiValue("tok2", "v")?.value).toBe(1); // полезные данные целы
  });
});

describe("GSI-листенер: свежесть и «недавнее исчезновение» (ревью фиксов #3)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("свежий пуш: fresh, не gone; протух недавно: recentlyGone; протух давно: ни то ни другое", async () => {
    await post("/age", JSON.stringify({ s: "x" }), JSON_HDR);
    const t0 = Date.now();
    expect(mod.gsiValue("age", "s")).toMatchObject({ fresh: true, recentlyGone: false });
    // Через минуту (STALE_MS деф 45с < 60с < окна 4×45с=180с): «только что исчез» — законный gone.
    vi.spyOn(Date, "now").mockReturnValue(t0 + 60_000);
    expect(mod.gsiValue("age", "s")).toMatchObject({ fresh: false, recentlyGone: true });
    // Через ~7 минут (за окном): запись прошлой сессии — операционно «нет данных», gone НЕ засчитывать.
    vi.spyOn(Date, "now").mockReturnValue(t0 + 400_000);
    expect(mod.gsiValue("age", "s")).toMatchObject({ fresh: false, recentlyGone: false });
  });
});
