/**
 * W2 (пакет 0): поколение сайдкара и несколько подписчиков рестарта — на НАСТОЯЩЕМ процессе (node без аргументов
 * ждёт stdin, как сайдкар). После падения: поколение +1 и зовутся ВСЕ подписчики (восстановление raw-input и сброс
 * зеркала handle). Реверт: вернуть единственный restartHandler — второй подписчик не вызовется.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SidecarClient } from "./sidecar-client.js";

let sc: SidecarClient | null = null;
afterEach(() => {
  sc?.stop();
  sc = null;
});

describe("SidecarClient.generation / onRestarted", () => {
  it("старт — поколение 1; падение → авто-рестарт, поколение 2, оба подписчика вызваны", async () => {
    sc = new SidecarClient();
    expect(sc.generation).toBe(0);
    sc.start(process.execPath);
    expect(sc.generation).toBe(1);
    const called: string[] = [];
    sc.onRestarted(() => called.push("raw-input"));
    sc.onRestarted(() => called.push("mirror"));
    (sc as unknown as { child: { kill(): void } }).child.kill();
    const until = Date.now() + 5_000;
    while (called.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(called).toEqual(["raw-input", "mirror"]);
    expect(sc.generation).toBe(2);
  }, 10_000);
});
