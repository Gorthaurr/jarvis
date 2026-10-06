import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ transcribe: vi.fn(), load: vi.fn() }));
vi.mock("@huggingface/transformers", () => ({ pipeline: fake.load, env: {} }));
beforeEach(() => { vi.resetModules(); fake.transcribe.mockReset(); fake.load.mockReset().mockResolvedValue(fake.transcribe); });
const phrase = () => new Int16Array(16_000).fill(5000).buffer;
afterEach(() => vi.useRealTimers());

it("local wake rescue receives the same final text as the Whisper stream", async () => {
  const { WhisperSttProvider } = await import("./whisper-stt.js");
  const { PipelineRescue } = await import("../voice/pipeline-rescue.js");
  fake.transcribe.mockResolvedValue({ text: "Джарвис, открой блокнот" });
  const startTurn = vi.fn();
  const rescue = new PipelineRescue({ stt: () => new WhisperSttProvider(), normalize: (s) => s,
    now: () => Date.now(), idle: () => true, speakerStrict: () => false, clearSpeakerFlag: vi.fn(),
    gate: () => "открой блокнот", openWindow: vi.fn(), startTurn });
  expect(await rescue.run(phrase(), 16_000, { ms: 1000, peak: 0.3 })).toBe("accepted");
  expect(startTurn).toHaveBeenCalledWith("открой блокнот");
  expect(fake.transcribe).toHaveBeenCalledOnce();
});

it("rejected background speech is absent from every log sink", async () => {
  const { addLogSink } = await import("@jarvis/shared");
  const { WhisperSttProvider } = await import("./whisper-stt.js");
  const { PipelineRescue } = await import("../voice/pipeline-rescue.js");
  const entries: unknown[] = []; const remove = addLogSink((entry) => entries.push(entry));
  const privateText = "PRIVATE_BACKGROUND_TRANSCRIPT_42";
  fake.transcribe.mockResolvedValue({ text: privateText });
  const startTurn = vi.fn();
  const rescue = new PipelineRescue({ stt: () => new WhisperSttProvider(), normalize: (s) => s,
    now: () => Date.now(), idle: () => true, speakerStrict: () => false, clearSpeakerFlag: vi.fn(),
    gate: (s) => s, openWindow: vi.fn(), startTurn });
  try {
    expect(await rescue.run(phrase(), 16_000, { ms: 1000, peak: 0.3 })).toBe("rejected");
    expect(startTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(entries)).not.toContain(privateText);
  } finally { remove(); }
});

it("deadline frees wake rescue and a late transcript never starts a task or enters logs", async () => {
  vi.useFakeTimers();
  const { addLogSink } = await import("@jarvis/shared");
  const { WhisperSttProvider } = await import("./whisper-stt.js");
  const { PipelineRescue } = await import("../voice/pipeline-rescue.js");
  const entries: unknown[] = []; const remove = addLogSink((entry) => entries.push(entry));
  let done!: (v: { text: string }) => void;
  fake.transcribe.mockImplementationOnce(() => new Promise((r) => { done = r; }));
  const startTurn = vi.fn();
  const rescue = new PipelineRescue({ stt: () => new WhisperSttProvider(), normalize: (s) => s,
    now: () => Date.now(), idle: () => true, speakerStrict: () => false, clearSpeakerFlag: vi.fn(),
    gate: (s) => s, openWindow: vi.fn(), startTurn });
  try {
    const pending = rescue.run(phrase(), 16_000, { ms: 1000, peak: 0.3 });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await pending).toBe("skipped");
    done({ text: "Джарвис LATE_PRIVATE_COMMAND_42" });
    await vi.advanceTimersByTimeAsync(0);
    expect(startTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(entries)).not.toContain("LATE_PRIVATE_COMMAND_42");
    fake.transcribe.mockResolvedValueOnce({ text: "Джарвис, открой блокнот" });
    expect(await rescue.run(phrase(), 16_000, { ms: 1000, peak: 0.3 })).toBe("accepted");
    expect(startTurn).toHaveBeenCalledOnce();
  } finally { remove(); }
});

it("silence closes exactly once and does not load the model", async () => {
  const { WhisperSttProvider } = await import("./whisper-stt.js");
  const provider = new WhisperSttProvider();
  expect(await provider.transcribeOnce(new ArrayBuffer(32_000), 16_000)).toBe("");
  const close = vi.fn(); const stream = provider.open({ sampleRate: 16_000 });
  stream.onClose(close); await stream.close();
  expect(close).toHaveBeenCalledOnce(); expect(fake.load).not.toHaveBeenCalled();
});

it("model errors, invalid audio and cancellation never become a successful transcript", async () => {
  const { WhisperSttProvider } = await import("./whisper-stt.js");
  const provider = new WhisperSttProvider();
  await expect(provider.transcribeOnce(phrase(), 48_000)).rejects.toThrow("16000");
  await expect(provider.transcribeOnce(new ArrayBuffer(3), 16_000)).rejects.toThrow("length");
  fake.transcribe.mockRejectedValueOnce(new Error("inference failed"));
  await expect(provider.transcribeOnce(phrase(), 16_000)).rejects.toThrow("inference failed");
  let done!: (v: { text: string }) => void;
  fake.transcribe.mockImplementationOnce(() => new Promise((r) => { done = r; }));
  const abort = new AbortController(); const pending = provider.transcribeOnce(phrase(), 16_000, abort.signal);
  await vi.waitFor(() => expect(done).toBeTypeOf("function")); abort.abort();
  await expect(pending).rejects.toThrow("aborted"); done({ text: "too late" });
});
