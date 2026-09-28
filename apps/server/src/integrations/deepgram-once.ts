/**
 * Разовое распознавание короткого фрагмента (подстраховка слова «Джарвис», 28.09): REST /v1/listen, сырой PCM16.
 * Те же модель и язык, что у стрима; keyterm не шлём (см. buildDeepgramUrl). Ключ идёт только заголовком Authorization.
 * Таймаут короткий: фраза ждёт ответа, а не наоборот — дольше владелец успеет повторить «Джарвис».
 */
const DEEPGRAM_REST = "https://api.deepgram.com/v1/listen";
const RESCUE_TIMEOUT_MS = 4_000;

export async function deepgramTranscribeOnce(apiKey: string | undefined, pcm: ArrayBuffer, sampleRate: number, signal?: AbortSignal): Promise<string> {
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY не задан");
  const p = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || "nova-3",
    language: "ru",
    encoding: "linear16",
    sample_rate: String(sampleRate),
    channels: "1",
    smart_format: "true",
  });
  const res = await fetch(`${DEEPGRAM_REST}?${p.toString()}`, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/octet-stream" },
    body: pcm,
    signal: signal ?? AbortSignal.timeout(RESCUE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`deepgram REST ${res.status}`);
  const j = (await res.json()) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
  return (j.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
}
