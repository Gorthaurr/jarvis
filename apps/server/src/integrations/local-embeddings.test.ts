import { beforeEach, describe, expect, it, vi } from "vitest";

// Мок @huggingface/transformers: фейковый feature-extraction pipeline. vi.hoisted — чтобы фабрика
// мока (поднимается наверх) видела общие переменные. Значения вектора ТОЧНЫ в float32 (0.5/0.25/0.125 —
// двоичные дроби), иначе Array.from(Float32Array) дал бы 0.1→0.10000000149 и toEqual упал бы.
const h = vi.hoisted(() => ({ mode: "ok" as "ok" | "throw", calls: [] as string[], opts: [] as unknown[] }));

vi.mock("@huggingface/transformers", () => ({
  env: {},
  pipeline: async (_task: string, _model: string, _opts?: unknown) => {
    if (h.mode === "throw") throw new Error("model load failed");
    return async (text: string, opts?: unknown) => {
      h.calls.push(text);
      h.opts.push(opts);
      return { data: new Float32Array([0.5, 0.25, 0.125]) };
    };
  },
}));

import { LocalEmbeddingProvider } from "./local-embeddings.js";

beforeEach(() => {
  h.mode = "ok";
  h.calls.length = 0;
  h.opts.length = 0;
});

describe("LocalEmbeddingProvider (e5, §1)", () => {
  it("применяет e5-префиксы по роли: query/passage", async () => {
    const p = new LocalEmbeddingProvider();
    await p.embed("привет", "query");
    await p.embed("кот любит рыбу", "passage");
    expect(h.calls).toEqual(["query: привет", "passage: кот любит рыбу"]);
  });

  it("kind по умолчанию = query; mean-pooling + normalize; возвращает вектор", async () => {
    const p = new LocalEmbeddingProvider();
    const v = await p.embed("текст");
    expect(h.calls[0]).toBe("query: текст");
    expect(h.opts[0]).toEqual({ pooling: "mean", normalize: true });
    expect(v).toEqual([0.5, 0.25, 0.125]);
  });

  it("сбой загрузки модели → null + НЕ пытается повторно (честная деградация, не мусор)", async () => {
    h.mode = "throw";
    const p = new LocalEmbeddingProvider();
    expect(await p.embed("a")).toBeNull();
    expect(await p.embed("b")).toBeNull();
    expect(h.calls).toEqual([]); // ни один inference не дошёл — после сбоя быстрый null
  });

  it("dim = 384 (e5-small)", () => {
    expect(new LocalEmbeddingProvider().dim).toBe(384);
  });
});
