// Пробник «отравления»: cpu-попытка ПЕРЕД dml — поднимется ли dml после провала cpu?
// Порядок берётся из argv: node _probe_embed_poison.mjs cpu dml  |  node _probe_embed_poison.mjs dml
const devices = process.argv.slice(2);
const mod = await import("@huggingface/transformers");
mod.env.remoteHost = process.env.HF_ENDPOINT || "https://hf-mirror.com";
const model = "intfloat/multilingual-e5-small";
for (const device of devices) {
  const t0 = Date.now();
  try {
    const pipe = await mod.pipeline("feature-extraction", model, { device, dtype: "fp32" });
    const out = await pipe("query: проверка", { pooling: "mean", normalize: true });
    console.log(`[OK] device=${device} dim=${out.data.length} за ${Date.now() - t0}мс`);
  } catch (e) {
    console.log(`[FAIL] device=${device} за ${Date.now() - t0}мс: ${e instanceof Error ? e.message : String(e)}`);
  }
}
