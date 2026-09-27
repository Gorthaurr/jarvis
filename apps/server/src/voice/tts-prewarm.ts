/**
 * W3 (V-5): прогрев кеша TTS служебными фразами на старте сессии.
 *
 * ack промоушена («Берусь, сэр», «Секунду, сэр») звучит на каждом ходе с руками, и первый раз на КАЖДУЮ фразу
 * и подачу (ключ кеша включает голос/эмоцию/скорость) он синтезировался вживую — ~180 мс до первого звука хода.
 * Прогоняем фразы через `CachingTtsProvider` той же подачей, что возьмёт пайплайн (`voice.voiceOpts()`), —
 * к первому промоушену они уже в кеше. Не кеширующий TTS не трогаем: там прогрев — чистая трата символов.
 * Последовательно (не бьём провайдера пачкой); сбой синтеза — не ошибка сессии, фраза просто синтезируется вживую.
 */
import { CachingTtsProvider } from "../integrations/tts-cache.js";
import type { ITtsProvider, TtsOpts, TtsStream } from "../integrations/voice-providers.js";

/** Потолок ожидания одной фразы: зависший провайдер не держит прогрев вечно. */
const PHRASE_TIMEOUT_MS = 15_000;

/** Дочитать синтез до конца (в кеш кладёт CachingTtsProvider по onDone). true — пришёл хоть один чанк. */
function drain(stream: TtsStream): Promise<boolean> {
  return new Promise((resolve) => {
    let chunks = 0;
    const timer = setTimeout(() => {
      stream.cancel();
      resolve(false);
    }, PHRASE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    stream.onChunk(() => {
      chunks += 1;
    });
    stream.onError(() => {
      clearTimeout(timer);
      resolve(false);
    });
    stream.onDone(() => {
      clearTimeout(timer);
      resolve(chunks > 0);
    });
  });
}

/** Прогреть кеш фразами `texts` подачей `opts`. Возвращает число фраз, что теперь лежат в кеше. Никогда не бросает. */
export async function prewarmTts(tts: ITtsProvider, texts: readonly string[], opts: TtsOpts | undefined): Promise<number> {
  if (!(tts instanceof CachingTtsProvider)) return 0;
  let warmed = 0;
  for (const text of texts) {
    try {
      if (await drain(tts.synthesize(text, opts))) warmed += 1;
    } catch {
      // синтез не поднялся — фраза прозвучит вживую, как раньше
    }
  }
  return warmed;
}
