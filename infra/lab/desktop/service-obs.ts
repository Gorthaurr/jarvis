import { ObsReject, missing, timecode, uuid, type Obs } from "./service-obs-state.js";
/**
 * obs.request FakeDesktop — фейковые ответы OBS WebSocket v5. Форма как у actuators/obs.ts: `{requestType, responseData}`;
 * отказ OBS — `runtime` «OBS отклонил X: code=N comment» (коды v5: 204 неизвестный запрос, 300 нет поля, 500/501 вывод
 * уже идёт/не идёт, 600/601 нет ресурса/уже есть). OBS должен быть ЗАПУЩЕН (окно obs64) и WebSocket включён — иначе, как у
 * клиента, «OBS не ответил». Ключ трансляции (streamServiceSettings.key) хранится, но в журнал эффектов не попадает.
 */
import type { ActionCommand } from "@jarvis/protocol";
import type { DesktopCore, KindHandlers } from "./core.js";
import type { ServiceOptions } from "./service-options.js";
import { putFile, redact, runState } from "./service-state.js";

export function obsHandlers(core: DesktopCore, opts: () => ServiceOptions): KindHandlers {
  const st = (): Obs =>
    runState<Obs>(core, "obs", () => ({
      scene: "Scene",
      scenes: ["Scene", "Game", "Desktop"],
      streaming: false,
      streamStart: 0,
      recording: false,
      recordPaused: false,
      recordStart: 0,
      muted: new Map(),
      inputs: [{ inputName: "Mic/Aux", inputKind: "wasapi_input_capture" }, { inputName: "Desktop Audio", inputKind: "wasapi_output_capture" }],
      stream: { streamServiceType: "rtmp_common", streamServiceSettings: {} },
    }));

  function respond(o: Obs, type: string, d: Record<string, unknown>): Record<string, unknown> {
    const name = (f: string): string => (typeof d[f] === "string" && d[f] ? (d[f] as string) : missing(f));
    const input = (): string => {
      const n = name("inputName");
      if (!o.inputs.some((i) => i.inputName === n)) throw new ObsReject(600, `No input was found by the name of \`${n}\`.`);
      return n;
    };
    const out = (active: boolean, since: number): Record<string, unknown> => ({ outputActive: active, outputTimecode: active ? timecode(core.now() - since) : "00:00:00.000", outputDuration: active ? core.now() - since : 0, outputBytes: 0 });
    switch (type) {
      case "GetVersion":
        return { obsVersion: "30.2.3", obsWebSocketVersion: "5.5.4", rpcVersion: 1, platform: "windows", platformDescription: "Windows 10", supportedImageFormats: ["png", "jpg"], availableRequests: ["GetVersion", "GetSceneList", "SetCurrentProgramScene", "GetStreamStatus", "StartStream", "StopStream", "StartRecord", "StopRecord", "SetInputMute"] };
      case "GetStats":
        return { cpuUsage: 3.2, memoryUsage: 412.5, availableDiskSpace: 250000, activeFps: 60, averageFrameRenderTime: 1.1, renderSkippedFrames: 0, renderTotalFrames: 0, outputSkippedFrames: 0, outputTotalFrames: 0 };
      case "GetSceneList":
        return { currentProgramSceneName: o.scene, currentProgramSceneUuid: uuid(o.scene), currentPreviewSceneName: null, scenes: o.scenes.map((sceneName, i) => ({ sceneIndex: o.scenes.length - 1 - i, sceneName, sceneUuid: uuid(sceneName) })).reverse() };
      case "GetCurrentProgramScene":
        return { sceneName: o.scene, sceneUuid: uuid(o.scene), currentProgramSceneName: o.scene, currentProgramSceneUuid: uuid(o.scene) };
      case "SetCurrentProgramScene": {
        const n = name("sceneName");
        if (!o.scenes.includes(n)) throw new ObsReject(600, `No scene was found by the name of \`${n}\`.`);
        o.scene = n;
        return {};
      }
      case "CreateScene": {
        const n = name("sceneName");
        if (o.scenes.includes(n)) throw new ObsReject(601, "A scene already exists by that name.");
        o.scenes.push(n);
        return { sceneUuid: uuid(n) };
      }
      case "GetStreamStatus":
        return { ...out(o.streaming, o.streamStart), outputReconnecting: false, outputCongestion: 0, outputSkippedFrames: 0, outputTotalFrames: 0 };
      case "StartStream":
      case "StopStream":
      case "ToggleStream": {
        const want = type === "ToggleStream" ? !o.streaming : type === "StartStream";
        if (type !== "ToggleStream" && want === o.streaming) throw new ObsReject(want ? 500 : 501, want ? "The output is running." : "The output is not running.");
        o.streaming = want;
        o.streamStart = core.now();
        return type === "ToggleStream" ? { outputActive: want } : {};
      }
      case "GetRecordStatus":
        return { ...out(o.recording, o.recordStart), outputPaused: o.recordPaused };
      case "StartRecord":
      case "StopRecord":
      case "ToggleRecord": {
        const want = type === "ToggleRecord" ? !o.recording : type === "StartRecord";
        if (type !== "ToggleRecord" && want === o.recording) throw new ObsReject(want ? 500 : 501, want ? "The output is running." : "The output is not running.");
        o.recording = want;
        if (want) {
          o.recordStart = core.now();
          return type === "ToggleRecord" ? { outputActive: true } : {};
        }
        const outputPath = `${core.fs.home}/Videos/lab-${o.recordStart}.mkv`;
        core.fs.dirs.add(`${core.fs.home}/Videos`);
        putFile(core, outputPath, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]), "obs.record");
        return type === "ToggleRecord" ? { outputActive: false } : { outputPath };
      }
      case "GetInputList":
        return { inputs: o.inputs.map((i) => ({ ...i, unversionedInputKind: i.inputKind, inputUuid: uuid(i.inputName) })) };
      case "GetInputMute":
        return { inputMuted: o.muted.get(input()) ?? false };
      case "SetInputMute": {
        const n = input();
        if (typeof d.inputMuted !== "boolean") missing("inputMuted");
        o.muted.set(n, d.inputMuted as boolean);
        return {};
      }
      case "ToggleInputMute": {
        const n = input();
        o.muted.set(n, !(o.muted.get(n) ?? false));
        return { inputMuted: o.muted.get(n) };
      }
      case "GetStreamServiceSettings":
        return { ...o.stream };
      case "SetStreamServiceSettings": {
        const type2 = name("streamServiceType");
        const settings = d.streamServiceSettings;
        if (!settings || typeof settings !== "object") missing("streamServiceSettings");
        o.stream = { streamServiceType: type2, streamServiceSettings: { ...(settings as Record<string, unknown>) } };
        return {};
      }
      default:
        throw new ObsReject(204, "Unknown request type.");
    }
  }

  return {
    "obs.request": (cmd, meta) => {
      const c = cmd as Extract<ActionCommand, { kind: "obs.request" }>;
      const o = opts();
      const running = [...core.windows.values()].some((w) => /^obs(64)?$/iu.test(w.process));
      if (!o.obsWebsocket || (o.obsRequiresRunning && !running)) {
        return core.fail(meta.commandId, "runtime", "OBS не ответил за 10с — запущен ли OBS и включён ли WebSocket-сервер на порту 4455?");
      }
      try {
        const responseData = respond(st(), c.requestType, c.requestData ?? {});
        core.effect("obs.request", { requestType: c.requestType, requestData: redact(c.requestData ?? {}), ok: true });
        return core.ok(meta.commandId, { requestType: c.requestType, responseData });
      } catch (e) {
        if (!(e instanceof ObsReject)) throw e;
        core.effect("obs.request", { requestType: c.requestType, ok: false, code: e.code });
        return core.fail(meta.commandId, "runtime", `OBS отклонил ${c.requestType}: code=${e.code} ${e.comment}`);
      }
    },
  };
}

