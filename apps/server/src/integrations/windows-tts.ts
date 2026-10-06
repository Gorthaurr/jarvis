/** Бесплатный офлайн TTS Windows. Текст идёт stdin как JSON, никогда не вставляется в PowerShell-код. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ITtsProvider, TtsChunk, TtsOpts, TtsStream } from "./voice-providers.js";

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$audio = New-Object IO.MemoryStream
try {
  $voice = $speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ru-RU' } | Select-Object -First 1
  if (-not $voice) { throw 'Russian Windows voice is not installed' }
  $speaker.SelectVoice($voice.VoiceInfo.Name)
  $speaker.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$request.rate))
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $speaker.SetOutputToAudioStream($audio, $format)
  $speaker.Speak([string]$request.text)
  [Console]::Out.Write([Convert]::ToBase64String($audio.ToArray()))
} finally { $speaker.Dispose(); $audio.Dispose() }
`;

export class WindowsTtsProvider implements ITtsProvider {
  readonly live = process.platform === "win32";
  synthesize(text: string, opts: TtsOpts = {}): TtsStream {
    let chunk: ((c: TtsChunk) => void) | undefined, error: ((e: Error) => void) | undefined, done: (() => void) | undefined;
    let cancelled = false, ended = false;
    let child: ReturnType<typeof spawn> | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (e?: Error) => {
      if (ended) return; ended = true; clearTimeout(timer);
      if (!cancelled) { if (e) error?.(e); done?.(); }
    };
    queueMicrotask(() => {
      if (cancelled) return;
      if (!this.live) { finish(new Error("Windows TTS доступен только на Windows")); return; }
      const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")],
        { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      const output: Buffer[] = []; let bytes = 0;
      child.stdout!.on("data", (b: Buffer) => {
        bytes += b.length;
        if (bytes > 16_000_000) { child?.kill(); finish(new Error("Windows TTS: слишком длинное аудио")); }
        else output.push(b);
      });
      child.stderr!.resume();
      child.stdin!.on("error", (e) => finish(e));
      child.on("error", (e) => finish(e));
      child.on("close", (code) => {
        if (cancelled || ended) return;
        if (code !== 0) { finish(new Error("Windows TTS: синтез не удался; проверьте русский голос Windows")); return; }
        const audio = Buffer.from(Buffer.concat(output).toString("ascii"), "base64");
        if (!audio.length) { finish(new Error("Windows TTS: пустое аудио")); return; }
        chunk?.({ audio: Uint8Array.from(audio).buffer, seq: 0, last: true, format: "pcm16", sampleRate: 16_000 }); finish();
      });
      timer = setTimeout(() => { child?.kill(); finish(new Error("Windows TTS: таймаут")); }, 30_000);
      child.stdin!.end(Buffer.from(JSON.stringify({ text, rate: Math.round(((opts.speed ?? 1) - 1) * 10) }), "utf8").toString("base64"));
    });
    return { get cancelled() { return cancelled; }, onChunk: (cb) => { chunk = cb; }, onError: (cb) => { error = cb; }, onDone: (cb) => { done = cb; },
      cancel: () => { cancelled = true; child?.kill(); finish(); } };
  }
}
