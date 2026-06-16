import { describe, expect, it } from "vitest";
import {
  type VoiceContext,
  type VoiceAction,
  initialContext,
  reduce,
} from "./state.js";

function types(actions: VoiceAction[]): string[] {
  return actions.map((a) => a.type);
}

describe("voice state machine (§10)", () => {
  it("idle + wake → listening, открывает STT", () => {
    const r = reduce(initialContext(), { type: "wake" });
    expect(r.context.state).toBe("listening");
    expect(types(r.actions)).toEqual(["set_client_state", "open_stt"]);
  });

  it("idle игнорирует речь без wake word (privacy §0.6)", () => {
    const r = reduce(initialContext(), { type: "speech_start" });
    expect(r.context.state).toBe("idle");
    expect(r.actions).toHaveLength(0);
  });

  it("listening + speech_end → финализация STT", () => {
    const ctx: VoiceContext = { state: "listening", followupActive: false };
    const r = reduce(ctx, { type: "speech_end" });
    expect(types(r.actions)).toContain("close_stt");
  });

  it("listening + transcript_final(text) → thinking, вызывает agent и закрывает STT", () => {
    const ctx: VoiceContext = { state: "listening", followupActive: false };
    const r = reduce(ctx, { type: "transcript_final", text: "который час" });
    expect(r.context.state).toBe("thinking");
    expect(types(r.actions)).toContain("call_agent");
    expect(types(r.actions)).toContain("close_stt");
  });

  it("listening + пустой transcript_final → idle", () => {
    const ctx: VoiceContext = { state: "listening", followupActive: false };
    const r = reduce(ctx, { type: "transcript_final", text: "   " });
    expect(r.context.state).toBe("idle");
  });

  it("пустой final в follow-up окне — досиживаем (остаёмся listening)", () => {
    const ctx: VoiceContext = { state: "listening", followupActive: true };
    const r = reduce(ctx, { type: "transcript_final", text: "" });
    expect(r.context.state).toBe("listening");
    expect(r.context.followupActive).toBe(true);
  });

  it("thinking + speak_start → speaking", () => {
    const ctx: VoiceContext = { state: "thinking", followupActive: false };
    const r = reduce(ctx, { type: "speak_start" });
    expect(r.context.state).toBe("speaking");
  });

  it("speaking + barge_in → listening, рубит TTS и открывает STT (§10)", () => {
    const ctx: VoiceContext = { state: "speaking", followupActive: false };
    const r = reduce(ctx, { type: "barge_in" });
    expect(r.context.state).toBe("listening");
    expect(types(r.actions)).toContain("cancel_tts");
    expect(types(r.actions)).toContain("open_stt");
  });

  it("speaking + speech_start тоже трактуется как barge-in", () => {
    const ctx: VoiceContext = { state: "speaking", followupActive: false };
    const r = reduce(ctx, { type: "speech_start" });
    expect(r.context.state).toBe("listening");
    expect(types(r.actions)).toContain("cancel_tts");
  });

  it("speaking + speak_done → listening с follow-up окном (§10)", () => {
    const ctx: VoiceContext = { state: "speaking", followupActive: false };
    const r = reduce(ctx, { type: "speak_done" });
    expect(r.context.state).toBe("listening");
    expect(r.context.followupActive).toBe(true);
    expect(types(r.actions)).toContain("arm_followup");
  });

  it("§20: idle + speak_start → speaking (фоновый итог/проактивность из покоя)", () => {
    const r = reduce(initialContext(), { type: "speak_start" });
    expect(r.context.state).toBe("speaking");
    expect(types(r.actions)).toContain("set_client_state");
  });

  it("§20: listening(follow-up) + speak_start → speaking, гасит таймер follow-up", () => {
    const ctx: VoiceContext = { state: "listening", followupActive: true };
    const r = reduce(ctx, { type: "speak_start" });
    expect(r.context.state).toBe("speaking");
    expect(types(r.actions)).toContain("disarm_followup");
  });

  it("§20: полный цикл фонового итога переоткрывает микрофон (idle→speaking→listening+follow-up)", () => {
    // Раньше произнесённый фоном ВОПРОС не возвращал слух: speak_* игнорились вне thinking.
    const speaking = reduce(initialContext(), { type: "speak_start" });
    expect(speaking.context.state).toBe("speaking");
    const back = reduce(speaking.context, { type: "speak_done" });
    expect(back.context.state).toBe("listening");
    expect(back.context.followupActive).toBe(true);
    expect(types(back.actions)).toContain("open_stt"); // микрофон снова слушает
    expect(types(back.actions)).toContain("arm_followup");
  });

  it("follow-up: speech_start снимает follow-up и фиксирует реальный turn", () => {
    const ctx: VoiceContext = { state: "listening", followupActive: true };
    const r = reduce(ctx, { type: "speech_start" });
    expect(r.context.followupActive).toBe(false);
    expect(types(r.actions)).toContain("disarm_followup");
  });

  it("follow-up: timeout → idle", () => {
    const ctx: VoiceContext = { state: "listening", followupActive: true };
    const r = reduce(ctx, { type: "followup_timeout" });
    expect(r.context.state).toBe("idle");
    expect(types(r.actions)).toContain("disarm_followup");
  });

  it("stop из speaking → idle с cancel_tts (заткнись §20)", () => {
    const ctx: VoiceContext = { state: "speaking", followupActive: false };
    const r = reduce(ctx, { type: "stop" });
    expect(r.context.state).toBe("idle");
    expect(types(r.actions)).toContain("cancel_tts");
  });

  it("mute из listening → idle с close_stt (§0.6)", () => {
    const ctx: VoiceContext = { state: "listening", followupActive: true };
    const r = reduce(ctx, { type: "mute" });
    expect(r.context.state).toBe("idle");
    expect(types(r.actions)).toContain("close_stt");
    expect(types(r.actions)).toContain("disarm_followup");
  });

  it("thinking + barge_in → listening (перебивание на этапе обдумывания)", () => {
    const ctx: VoiceContext = { state: "thinking", followupActive: false };
    const r = reduce(ctx, { type: "barge_in" });
    expect(r.context.state).toBe("listening");
    expect(types(r.actions)).toContain("open_stt");
  });
});
