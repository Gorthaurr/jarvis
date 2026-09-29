import { afterEach, describe, expect, it } from "vitest";
import { resetServiceOptions } from "./service-handlers.js";
import { errOf, rig } from "./service-rig.js";

afterEach(() => resetServiceOptions());

const obsSeed = { windows: [{ title: "OBS 30.2.3", process: "obs64" }] };
const req = (requestType: string, requestData?: Record<string, unknown>) => ({ kind: "obs.request" as const, requestType, ...(requestData ? { requestData } : {}) });
const data = (r: { data?: unknown }): Record<string, unknown> => (r.data as { responseData: Record<string, unknown> }).responseData;

describe("obs.request", () => {
  it("OBS не запущен — «не ответил», как у клиента; запущен — GetVersion в форме {requestType, responseData}", async () => {
    const off = rig();
    const bad = await off.call(req("GetVersion"));
    expect(bad.ok).toBe(false);
    expect(errOf(bad)).toContain("OBS не ответил");
    expect(off.kinds("obs.request")).toHaveLength(0);
    const on = rig(obsSeed);
    const ok = await on.call(req("GetVersion"));
    expect(ok.data).toMatchObject({ requestType: "GetVersion", responseData: { rpcVersion: 1, obsWebSocketVersion: "5.5.4" } });
  });

  it("WebSocket выключен в настройках OBS — тот же отказ, даже если процесс есть", async () => {
    const r = rig(obsSeed, { obsWebsocket: false });
    expect(errOf(await r.call(req("GetVersion")))).toContain("OBS не ответил");
  });

  it("сцена: переключение видно при обратном чтении; неизвестная сцена — code=600", async () => {
    const r = rig(obsSeed);
    expect(data(await r.call(req("GetCurrentProgramScene"))).sceneName).toBe("Scene");
    expect((await r.call(req("SetCurrentProgramScene", { sceneName: "Game" }))).ok).toBe(true);
    expect(data(await r.call(req("GetCurrentProgramScene"))).sceneName).toBe("Game");
    const miss = await r.call(req("SetCurrentProgramScene", { sceneName: "Nope" }));
    expect(errOf(miss)).toMatch(/OBS отклонил SetCurrentProgramScene: code=600/u);
    expect(data(await r.call(req("GetCurrentProgramScene"))).sceneName).toBe("Game");
  });

  it("поле не задано — code=300; неизвестный запрос — code=204; отказ виден в журнале как ok:false", async () => {
    const r = rig(obsSeed);
    expect(errOf(await r.call(req("SetCurrentProgramScene")))).toContain("code=300");
    expect(errOf(await r.call(req("MakeCoffee")))).toContain("code=204");
    expect(r.kinds("obs.request").map((e) => e.ok)).toEqual([false, false]);
  });

  it("трансляция: повторный Start — code=500, Stop без Start — 501, статус следует за виртуальным временем", async () => {
    const r = rig(obsSeed);
    expect((await r.call(req("StartStream"))).ok).toBe(true);
    expect(errOf(await r.call(req("StartStream")))).toContain("code=500");
    r.core.advance(65_000);
    const st = data(await r.call(req("GetStreamStatus")));
    expect(st).toMatchObject({ outputActive: true, outputTimecode: "00:01:05.000" });
    expect((await r.call(req("StopStream"))).ok).toBe(true);
    expect(errOf(await r.call(req("StopStream")))).toContain("code=501");
  });

  it("запись: StopRecord кладёт файл в виртуальную ФС и возвращает его путь", async () => {
    const r = rig(obsSeed);
    await r.call(req("StartRecord"));
    r.core.advance(1000);
    const stop = data(await r.call(req("StopRecord")));
    const path = String(stop.outputPath);
    expect(r.core.fs.files.has(path)).toBe(true);
    expect(r.core.snapshot().files[path]).toEqual({ binary: 5 });
  });

  it("мьют входа: чтение возвращает записанное; несуществующий вход — code=600", async () => {
    const r = rig(obsSeed);
    await r.call(req("SetInputMute", { inputName: "Mic/Aux", inputMuted: true }));
    expect(data(await r.call(req("GetInputMute", { inputName: "Mic/Aux" }))).inputMuted).toBe(true);
    expect(data(await r.call(req("ToggleInputMute", { inputName: "Mic/Aux" }))).inputMuted).toBe(false);
    expect(errOf(await r.call(req("GetInputMute", { inputName: "Нет" })))).toContain("code=600");
  });

  it("ключ трансляции сохраняется для обратного чтения, но НЕ попадает в журнал эффектов", async () => {
    const r = rig(obsSeed);
    await r.call(req("SetStreamServiceSettings", { streamServiceType: "rtmp_custom", streamServiceSettings: { server: "rtmp://x/live", key: "live_SECRET_123" } }));
    expect(data(await r.call(req("GetStreamServiceSettings"))).streamServiceSettings).toMatchObject({ key: "live_SECRET_123" });
    expect(JSON.stringify(r.core.effects)).not.toContain("live_SECRET_123");
    expect(JSON.stringify(r.core.effects)).toContain("rtmp://x/live");
  });
});
