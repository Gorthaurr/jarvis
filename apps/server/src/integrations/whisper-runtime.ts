import { createLogger } from "@jarvis/shared";
const log = createLogger("stt:whisper");

/** Тип pipeline транскрайбера — нестрогий (SDK динамический). */
type Transcriber = (
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{ text?: string } | { text?: string }[]>;

let transcriberPromise: Promise<Transcriber> | null = null;

/** Лениво загрузить Whisper-пайплайн (один раз на процесс). */
export function getTranscriber(model: string): Promise<Transcriber> {
  if (transcriberPromise) return transcriberPromise;
  transcriberPromise = (async () => {
    const mod = (await import("@huggingface/transformers")) as unknown as {
      pipeline: (task: string, model: string, opts?: unknown) => Promise<Transcriber>;
      env: { remoteHost?: string; cacheDir?: string };
    };
    // huggingface.co часто недоступен из РФ → зеркало (или VPN). Настраивается HF_ENDPOINT.
    const endpoint = process.env.HF_ENDPOINT || "https://hf-mirror.com";
    mod.env.remoteHost = endpoint;

    // ВАЖНО (проверено на реальной речи): DirectML численно ломает whisper-large-v3-turbo
    // (fp16/q8 → словесная каша, fp32 → token_ids-краш). CPU+q8 транскрибирует ИДЕАЛЬНО
    // (~3с инференс). Так что слух идёт на CPU; ускорение — отдельным шагом (CUDA whisper.cpp).
    const device = process.env.WHISPER_DEVICE || "cpu";
    const dtype = process.env.WHISPER_DTYPE || "q8";
    log.info("Whisper: загрузка модели (первый раз — скачивание)", { model, endpoint, device, dtype });
    try {
      const t = await mod.pipeline("automatic-speech-recognition", model, { device, dtype });
      log.info("Whisper: модель готова", { model, device, dtype });
      return t;
    } catch (e) {
      // Конфиг не поднялся → честный откат на дефолтный CPU, чтобы слух не отвалился совсем.
      log.warn("Whisper: конфиг не поднялся — откат на дефолтный CPU", {
        err: e instanceof Error ? e.message : String(e),
      });
      transcriberPromise = null; // позволить повторную попытку при следующем обращении
      const t = await mod.pipeline("automatic-speech-recognition", model);
      log.info("Whisper: модель готова (CPU fallback)", { model });
      return t;
    }
  })();
  return transcriberPromise;
}

/** Прогреть модель на старте сервера — чтобы первая фраза не ждала загрузки/upload на GPU. */
export function warmupWhisper(model: string): void {
  log.info("Whisper: прогрев модели на старте", { model });
  void getTranscriber(model).catch((e) =>
    log.warn("Whisper: прогрев не удался", e instanceof Error ? e.message : String(e)),
  );
}
