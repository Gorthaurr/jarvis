/**
 * Фабрика голосовых провайдеров (§1, §10).
 *
 * STT/TTS строго за интерфейсами — провайдер заменяем без правок пайплайна.
 * Без ключей возвращаются Mock-реализации (сервер поднимается и работает в
 * текстовом dev-режиме; голос — no-op до конфигурации ключей).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { DeepgramSttProvider } from "./deepgram.js";
import { ElevenLabsTtsProvider } from "./elevenlabs.js";
import { type ISttProvider, type ITtsProvider, MockSttProvider, MockTtsProvider } from "./voice-providers.js";
import { WhisperSttProvider } from "./whisper-stt.js";
import { YandexTtsProvider } from "./yandex-tts.js";
import { YandexTtsV3Provider } from "./yandex-tts-v3.js";

const log: Logger = createLogger("voice:providers");

/**
 * STT (§10): deepgram при ключе; иначе локальный Whisper (без ключей, слух Джарвиса);
 * mock — только если явно STT_PROVIDER=mock. Выбор: cfg.provider или авто.
 */
export function createSttProvider(cfg: {
  deepgramApiKey?: string;
  provider?: string;
  whisperModel?: string;
}): ISttProvider {
  const provider = cfg.provider || (cfg.deepgramApiKey ? "deepgram" : "whisper");

  if (provider === "deepgram" && cfg.deepgramApiKey) {
    const p = new DeepgramSttProvider(cfg.deepgramApiKey);
    log.info("STT провайдер", { provider: "deepgram", live: p.live });
    return p;
  }
  if (provider === "whisper") {
    const model = cfg.whisperModel || "Xenova/whisper-base";
    log.info("STT провайдер", { provider: "whisper-local", model });
    return new WhisperSttProvider(model);
  }
  log.info("STT провайдер", { provider: "mock", live: false });
  return new MockSttProvider();
}

export function createTtsProvider(cfg: { elevenLabsApiKey?: string; voiceId?: string }): ITtsProvider {
  // §Волна3 (3.5) ОПТ-ИН: Yandex v3 (REST-стрим) — первые байты за ~150-300мс, чанки уходят клиенту
  // по мере синтеза (−300-600мс до первого звука на каждой фразе). Боевой дефолт остаётся v1.
  if ((process.env.TTS_PROVIDER || "").toLowerCase() === "yandex3" && process.env.YANDEX_API_KEY) {
    const p = new YandexTtsV3Provider({
      apiKey: process.env.YANDEX_API_KEY,
      folderId: process.env.YANDEX_FOLDER_ID,
      voiceId: process.env.YANDEX_VOICE,
    });
    log.info("TTS провайдер", { provider: "yandex3 (стрим)", live: p.live, voice: process.env.YANDEX_VOICE || "filipp" });
    return p;
  }
  // Русско-нативный Yandex (правильные ударения) — если выбран TTS_PROVIDER=yandex и есть ключ.
  if ((process.env.TTS_PROVIDER || "").toLowerCase() === "yandex" && process.env.YANDEX_API_KEY) {
    const p = new YandexTtsProvider({
      apiKey: process.env.YANDEX_API_KEY,
      folderId: process.env.YANDEX_FOLDER_ID,
      voiceId: process.env.YANDEX_VOICE,
    });
    log.info("TTS провайдер", { provider: "yandex", live: p.live, voice: process.env.YANDEX_VOICE || "filipp" });
    return p;
  }
  if (cfg.elevenLabsApiKey && cfg.voiceId) {
    const p = new ElevenLabsTtsProvider({ apiKey: cfg.elevenLabsApiKey, voiceId: cfg.voiceId });
    log.info("TTS провайдер", { provider: "elevenlabs", live: p.live });
    return p;
  }
  log.info("TTS провайдер", { provider: "mock", live: false });
  return new MockTtsProvider();
}
