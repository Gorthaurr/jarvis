/**
 * Разовое распознавание фрагмента (подстраховка «Джарвис», 28.09): REST /v1/listen, сырой PCM16. Форма запроса и ответа —
 * по контракту Deepgram (results.channels[0].alternatives[0].transcript); ключ уходит только заголовком Authorization.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepgramSttProvider } from "./deepgram.js";

const PCM = new ArrayBuffer(32_000);

afterEach(() => vi.unstubAllGlobals());

describe("DeepgramSttProvider.transcribeOnce", () => {
  it("POST на /v1/listen: модель, ru, linear16/16000, ключ в заголовке (не в URL), тело — PCM; возвращает transcript", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: " Джарвис, ты слышишь? " }] }] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const text = await new DeepgramSttProvider("k-test").transcribeOnce(PCM, 16_000);
    expect(text).toBe("Джарвис, ты слышишь?");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/^https:\/\/api\.deepgram\.com\/v1\/listen\?/u);
    const q = new URL(url).searchParams;
    expect(q.get("language")).toBe("ru");
    expect(q.get("encoding")).toBe("linear16");
    expect(q.get("sample_rate")).toBe("16000");
    expect(q.get("channels")).toBe("1");
    expect(url).not.toContain("k-test"); // ключ не в адресе
    expect((init.headers as Record<string, string>).Authorization).toBe("Token k-test");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(PCM);
  });

  it("пустой результат (тишина) → пустая строка, не исключение", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "" }] }] } }), { status: 200 })));
    expect(await new DeepgramSttProvider("k").transcribeOnce(PCM, 16_000)).toBe("");
  });

  it("HTTP-ошибка → бросает (WakeRescue отбросит фрагмент), нет ключа → бросает без сети", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 402 })));
    await expect(new DeepgramSttProvider("k").transcribeOnce(PCM, 16_000)).rejects.toThrow(/402/u);
    const never = vi.fn();
    vi.stubGlobal("fetch", never);
    await expect(new DeepgramSttProvider(undefined).transcribeOnce(PCM, 16_000)).rejects.toThrow(/DEEPGRAM_API_KEY/u);
    expect(never).not.toHaveBeenCalled();
  });
});
