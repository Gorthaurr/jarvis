import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockSpeakerVerifier } from "./verifier.js";
import { VoiceProfileStore } from "./store.js";

const DEV_USER = "00000000-0000-0000-0000-000000000001";
const UA = "11111111-1111-1111-1111-111111111111";
const UB = "22222222-2222-2222-2222-222222222222";

describe("VoiceProfileStore (§3 голосовые отпечатки, §мультитенант партиция по userId)", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jarvis-voices-"));
    path = join(dir, "voices.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("пустое хранилище → гейт юзера выключен (hasAny=false)", async () => {
    const s = new VoiceProfileStore(path);
    await s.load();
    expect(s.hasAny(UA)).toBe(false);
    expect(s.list(UA)).toHaveLength(0);
  });

  it("add сохраняет и переживает перезагрузку (персист, с userId)", async () => {
    const s = new VoiceProfileStore(path);
    await s.load();
    await s.add(UA, "Антон", new Uint8Array([1, 2, 3, 250]));
    expect(s.hasAny(UA)).toBe(true);

    const s2 = new VoiceProfileStore(path);
    await s2.load();
    expect(s2.list(UA).map((p) => p.name)).toEqual(["Антон"]);
    // байты профиля восстановлены 1:1 (base64 round-trip).
    expect(Array.from(s2.list(UA)[0]!.data)).toEqual([1, 2, 3, 250]);
  });

  it("повторный add того же имени тем же юзером — обновление, не дубль (регистронезависимо)", async () => {
    const s = new VoiceProfileStore(path);
    await s.load();
    await s.add(UA, "Катя", new Uint8Array([1]));
    await s.add(UA, "катя", new Uint8Array([9]));
    expect(s.list(UA)).toHaveLength(1);
    expect(Array.from(s.list(UA)[0]!.data)).toEqual([9]);
  });

  it("несколько голосов и remove в пределах юзера", async () => {
    const s = new VoiceProfileStore(path);
    await s.load();
    await s.add(UA, "Антон", new Uint8Array([1]));
    await s.add(UA, "Катя", new Uint8Array([2]));
    expect(s.list(UA)).toHaveLength(2);
    expect(await s.remove(UA, "Катя")).toBe(true);
    expect(await s.remove(UA, "Нет такого")).toBe(false);
    expect(s.list(UA).map((p) => p.name)).toEqual(["Антон"]);
  });

  it("§мультитенант: голоса РАЗНЫХ юзеров изолированы (один не видит чужие; одно имя у обоих ОК)", async () => {
    const s = new VoiceProfileStore(path);
    await s.load();
    await s.add(UA, "Антон", new Uint8Array([1]));
    await s.add(UB, "Антон", new Uint8Array([2])); // тёзка у другого юзера — отдельный профиль
    expect(s.list(UA)).toHaveLength(1);
    expect(s.list(UB)).toHaveLength(1);
    expect(Array.from(s.list(UA)[0]!.data)).toEqual([1]);
    expect(Array.from(s.list(UB)[0]!.data)).toEqual([2]);
    expect(s.total).toBe(2);
    // remove у одного юзера не трогает тёзку другого.
    expect(await s.remove(UA, "Антон")).toBe(true);
    expect(s.hasAny(UA)).toBe(false);
    expect(s.hasAny(UB)).toBe(true);
  });

  it("§мультитенант континьюити: legacy-профиль без userId → DEV_USER (голос Антона не теряется)", async () => {
    // Файл старого формата (без поля userId), как записала прошлая версия.
    await writeFile(
      path,
      JSON.stringify([{ name: "Антон", data: Buffer.from([7, 7]).toString("base64"), createdAt: 1 }]),
      "utf8",
    );
    const s = new VoiceProfileStore(path);
    await s.load();
    expect(s.list(DEV_USER).map((p) => p.name)).toEqual(["Антон"]); // отнесён к DEV_USER
    expect(s.list(UA)).toHaveLength(0); // чужому юзеру не виден
  });
});

describe("MockSpeakerVerifier", () => {
  it("по умолчанию движок НЕ готов (гейт выключен)", () => {
    expect(new MockSpeakerVerifier().ready).toBe(false);
  });

  it("enroll набирает готовность и отдаёт байты профиля", async () => {
    const v = new MockSpeakerVerifier({ ready: true });
    const s = v.enroll();
    let pct = 0;
    for (let i = 0; i < 60; i += 1) pct = await s.feed(new Int16Array(160));
    expect(pct).toBe(1);
    expect(await s.finish()).not.toBeNull();
  });

  it("identify по умолчанию опознаёт первый профиль как «своего»", async () => {
    const v = new MockSpeakerVerifier({ ready: true });
    const m = await v.identify(new Int16Array(160), [
      { name: "Антон", data: new Uint8Array([1]), createdAt: 1 },
    ]);
    expect(m?.name).toBe("Антон");
  });

  it("identify без профилей → null (никого не знаем)", async () => {
    const v = new MockSpeakerVerifier({ ready: true });
    expect(await v.identify(new Int16Array(160), [])).toBeNull();
  });
});
