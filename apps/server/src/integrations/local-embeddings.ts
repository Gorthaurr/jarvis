/**
 * Локальные эмбеддинги (multilingual-e5-small через @huggingface/transformers, §1).
 *
 * ЗАЧЕМ: дефолт без OPENAI_API_KEY раньше падал в HashEmbeddingProvider (bag-of-words хеш) —
 * это НЕ настоящие эмбеддинги, косинус по ним ≈ случаен → эпизодическая память/навыки «вспоминают»
 * мусор. Здесь — РЕАЛЬНАЯ модель, локально на CPU (универсально: работает на слабом арендованном
 * сервере БЕЗ GPU и БЕЗ ключа/облака; данные не уходят наружу — важно для приватности/152-ФЗ).
 *
 * Модель: intfloat/multilingual-e5-small (MIT, 384-dim, RU-нативная). e5 требует АСИММЕТРИЧНЫХ
 * префиксов: запрос → "query: …", сохраняемый факт → "passage: …" (kind). Веса качаются один раз
 * с HF-зеркала (HF_ENDPOINT, как Whisper). Инференс короткого текста на CPU — десятки мс.
 *
 * Честность по сбою: модель не загрузилась/инференс упал → embed возвращает null (пустой retrieval),
 * НЕ молчаливый мусор. Память честно деградирует, а не врёт похожестью случайных векторов.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { EmbeddingKind, IEmbeddingProvider } from "./openai-embeddings.js";

const log: Logger = createLogger("embeddings-local");

/** Нестрогий тип feature-extraction pipeline (SDK динамический). */
type FeatureExtractor = (
  text: string,
  opts?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array | number[] }>;

const DEFAULT_MODEL = "intfloat/multilingual-e5-small";
// ⚠️ env читаем В МОМЕНТ ВЫЗОВА (getPipe/конструктор), НЕ на module-load: `.env` грузится в index.ts
// main() ПОСЛЕ хойст-импортов (ESM), поэтому module-top `process.env.JARVIS_EMBED_*` был бы ПУСТ →
// device='cpu' по умолчанию, а сломанный CPU-EP onnxruntime-node на этой Windows отравляет нативный
// аддон → последующий dml в том же процессе уже не поднимается. Чтение при вызове = .env уже загружен.

// Кулдаун после сбоя: НЕ выключаем эмбеддер «навсегда» (старый баг — один транзиентный сбой инференса
// глушил память до перезапуска процесса и плодил записи с embedding=NULL). После сбоя ждём COOLDOWN и
// пробуем снова (с пересборкой пайпа). env JARVIS_EMBED_COOLDOWN_MS.
const FAIL_COOLDOWN_MS = (() => {
  const n = Number.parseInt(process.env.JARVIS_EMBED_COOLDOWN_MS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
})();

export class LocalEmbeddingProvider implements IEmbeddingProvider {
  readonly dim: number;
  readonly live = true;
  private pipePromise: Promise<FeatureExtractor> | null = null;
  private failedUntil = 0; // 0 = здоров; иначе — молчим до этого момента (мс), потом ретрай

  constructor() {
    // Конструктор зовётся на boot (createGateway) — ПОСЛЕ loadEnv, env уже доступен.
    this.dim = Number.parseInt(process.env.JARVIS_EMBED_DIM || "384", 10) || 384;
  }

  async embed(text: string, kind: EmbeddingKind = "query"): Promise<number[] | null> {
    if (this.failedUntil > Date.now()) return null; // в кулдауне после недавнего сбоя
    try {
      const pipe = await this.getPipe();
      // e5-контракт: префикс роли. «query: …» для поиска, «passage: …» для сохраняемого факта.
      const out = await pipe(`${kind}: ${text}`, { pooling: "mean", normalize: true });
      this.failedUntil = 0; // успех → сбрасываем кулдаун
      return Array.from(out.data as ArrayLike<number>);
    } catch (e) {
      // Сбой НЕ фатален: молчим кулдаун, пересобираем пайп (если упала именно инициализация),
      // дальше пробуем снова. Так память само-восстанавливается без перезапуска процесса.
      if (this.failedUntil <= Date.now()) {
        log.warn("локальный эмбеддер недоступен → retrieval пуст (ретрай через кулдаун)", e instanceof Error ? e.message : String(e));
      }
      this.failedUntil = Date.now() + FAIL_COOLDOWN_MS;
      this.pipePromise = null; // сбросить кэш пайпа — на следующей попытке инициализируем заново
      return null;
    }
  }

  private getPipe(): Promise<FeatureExtractor> {
    if (this.pipePromise) return this.pipePromise;
    this.pipePromise = (async () => {
      const mod = (await import("@huggingface/transformers")) as unknown as {
        pipeline: (task: string, model: string, opts?: unknown) => Promise<FeatureExtractor>;
        env: { remoteHost?: string; [k: string]: unknown };
      };
      // env читаем ЗДЕСЬ (после загрузки .env). device: 'cpu' (нативный onnxruntime-node — дефолт,
      // Linux-сервер) / 'dml' (DirectML, Windows+GPU) / 'webgpu'. dtype: 'fp32' (model.onnx) — дефолт,
      // т.к. 'q8' (model_quantized.onnx) на hf-mirror отсутствует (404).
      const model = process.env.JARVIS_EMBED_MODEL || DEFAULT_MODEL;
      const want = process.env.JARVIS_EMBED_DEVICE || "cpu";
      const dtype = process.env.JARVIS_EMBED_DTYPE || "fp32";
      // HF из РФ часто недоступен напрямую — зеркало (как в whisper-stt.ts).
      mod.env.remoteHost = process.env.HF_ENDPOINT || "https://hf-mirror.com";
      // Цепочка устройств: заданное → фолбэки. Нативный CPU-EP onnxruntime-node на НЕКОТОРЫХ Windows
      // НЕ грузится («The operating system cannot run %1»), но DirectML грузится; на Linux-сервере
      // штатно работает cpu. Первое успешно-инициализированное устройство выигрывает.
      const chain = [...new Set([want, "cpu", "dml", "webgpu"])];
      let lastErr: unknown;
      for (const device of chain) {
        try {
          const pipe = await mod.pipeline("feature-extraction", model, { device, dtype });
          if (device === want) log.info(`эмбеддер готов: ${model} @ ${device}/${dtype}`);
          else log.warn(`эмбеддер: устройство "${want}" не поднялось, работаю на "${device}"`);
          return pipe;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr ?? new Error("нет доступного устройства для эмбеддера");
    })();
    return this.pipePromise;
  }
}
