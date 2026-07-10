import { afterEach, describe, expect, it, vi } from "vitest";
import type { TtsChunk } from "./voice-providers.js";
import { YandexTtsProvider, tameYandexPunctuation } from "./yandex-tts.js";

afterEach(() => vi.unstubAllGlobals());

/** Дождаться чанков синтеза (onChunk → onDone). */
function drain(stream: { onChunk: (cb: (c: TtsChunk) => void) => void; onDone: (cb: () => void) => void }): Promise<TtsChunk[]> {
  return new Promise((resolve) => {
    const chunks: TtsChunk[] = [];
    stream.onChunk((c) => chunks.push(c));
    stream.onDone(() => resolve(chunks));
  });
}

describe("YandexTtsProvider (§21 русско-нативный TTS)", () => {
  it("без API-ключа → live=false (mock-режим)", () => {
    expect(new YandexTtsProvider({}).live).toBe(false);
  });

  it("с ключом: POST на SpeechKit с Api-Key и нужными параметрами, отдаёт один чанк", async () => {
    let captured: { url: string; init: { headers: Record<string, string>; body: { toString(): string } } } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string>; body: { toString(): string } }) => {
      captured = { url, init };
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response;
    });

    const p = new YandexTtsProvider({ apiKey: "k", folderId: "b1g", voiceId: "filipp" });
    expect(p.live).toBe(true);
    const chunks = await drain(p.synthesize("[warmly] Вам звонили, сэр."));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.last).toBe(true);
    expect(captured!.url).toContain("tts.api.cloud.yandex.net");
    expect(captured!.init.headers.Authorization).toBe("Api-Key k");
    const body = captured!.init.body.toString();
    expect(body).toContain("voice=filipp");
    expect(body).toContain("lang=ru-RU");
    expect(body).toContain("format=mp3");
    expect(body).toContain("folderId=b1g");
    // аудио-тег интонации ElevenLabs срезан (Yandex его не понимает)
    expect(decodeURIComponent(body)).not.toContain("warmly");
  });
});

describe("YandexTtsProvider · эмоция подачи (§21)", () => {
  function stubFetchBodies(): string[] {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: { toString(): string } }) => {
      bodies.push(init.body.toString());
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response;
    });
    return bodies;
  }

  it("jane+angry → emotion=evil; filipp+angry деградирует до emotion=strict", async () => {
    const bodies = stubFetchBodies();
    await drain(new YandexTtsProvider({ apiKey: "k", voiceId: "jane" }).synthesize("Готово", { emotion: "angry" }));
    expect(bodies[0]).toContain("emotion=evil");
    bodies.length = 0;
    await drain(new YandexTtsProvider({ apiKey: "k", voiceId: "filipp" }).synthesize("Готово", { emotion: "angry" }));
    expect(bodies[0]).toContain("emotion=strict");
  });

  it("jane+happy → emotion=good", async () => {
    const bodies = stubFetchBodies();
    await drain(new YandexTtsProvider({ apiKey: "k", voiceId: "jane" }).synthesize("Готово", { emotion: "happy" }));
    expect(bodies[0]).toContain("emotion=good");
  });

  it("эмоция, которую голос НЕ умеет (filipp+happy) → emotion не шлём (без HTTP 400)", async () => {
    const bodies = stubFetchBodies();
    await drain(new YandexTtsProvider({ apiKey: "k", voiceId: "filipp" }).synthesize("Готово", { emotion: "happy" }));
    expect(bodies[0]).not.toContain("emotion=");
  });
});

describe("tameYandexPunctuation — смягчение пауз под Yandex (§21)", () => {
  it("тире → запятая (короткая пауза вместо длинной)", () => {
    expect(tameYandexPunctuation("Добрый вечер, сэр — всё готово")).toBe(
      "Добрый вечер, сэр, всё готово",
    );
  });
  it("многоточие → запятая", () => {
    expect(tameYandexPunctuation("Ну… ладно")).toBe("Ну, ладно");
  });
  it("точку с запятой → запятая", () => {
    expect(tameYandexPunctuation("Готово; жду")).toBe("Готово, жду");
  });
  it("точку конца предложения → запятая (короткая пауза вместо долгой Yandex-паузы)", () => {
    expect(tameYandexPunctuation("Готово. Слышу вас, сэр.")).toBe("Готово, Слышу вас, сэр");
    // ?! несут интонацию вопроса/восклицания — оставляем
    expect(tameYandexPunctuation("Слышу вас. Чем помочь?")).toBe("Слышу вас, Чем помочь?");
  });
  it("подряд идущие паузные знаки схлопывает в одну запятую", () => {
    expect(tameYandexPunctuation("встречи… — позвоните")).toBe("встречи, позвоните");
  });
});
