/**
 * Замолкание ambient-почты на непонятной вёрстке (ревью 2026-09-24, T-F13).
 *
 * Живой случай: 77× `mail_layout_unknown` вхолостую — каждые 90 с расширение лезло во вкладку e.mail.ru,
 * вёрстку не узнавало и снова писало ту же деградацию. После MAIL_MUTE_AFTER_UNKNOWN подряд источник
 * замолкает (вкладку не дёргает), ОДИН раз пишет честную деградацию `mail_source_muted` и раз в час делает
 * пробу — сменили вкладку/вёрстку узнали → снова слушает. Владельцу голосом ничего не говорится.
 * Реверт-проверка: убрать ранний `if (muted) … return []` в poll → «6-й тик не читает вкладку» падает.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metrics } from "../../obs/metrics.js";
import { MAIL_MUTED_PROBE_MS, MAIL_MUTE_AFTER_UNKNOWN, createMailSource } from "./mail-source.js";

const UNKNOWN = { ok: true, recognized: false, host: "e.mail.ru", text: "страница" };

let clock = 1_000_000;
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  clock = 1_000_000;
  spy = vi.spyOn(metrics, "recordDegradation").mockImplementation(() => {});
});
afterEach(() => spy.mockRestore());

function source(replies: unknown[]) {
  let i = 0;
  const reader = { mailRead: vi.fn(async () => replies[Math.min(i++, replies.length - 1)]) };
  const src = createMailSource(reader, "u1", { now: () => clock });
  const tick = async () => {
    clock += 90_000; // интервал ambient-движка
    return src.poll();
  };
  return { reader, tick };
}

const mutedCount = () => spy.mock.calls.filter((c) => c[0] === "mail_source_muted").length;

describe("ambient-почта: непонятная вёрстка не читается вхолостую бесконечно (T-F13)", () => {
  it(`${MAIL_MUTE_AFTER_UNKNOWN} нераспознанных подряд → замолкает: деградация ОДИН раз, дальше вкладку не дёргает`, async () => {
    const { reader, tick } = source([UNKNOWN]);
    for (let k = 0; k < MAIL_MUTE_AFTER_UNKNOWN; k += 1) expect(await tick()).toEqual([]);
    expect(reader.mailRead).toHaveBeenCalledTimes(MAIL_MUTE_AFTER_UNKNOWN);
    expect(mutedCount()).toBe(1);

    for (let k = 0; k < 10; k += 1) await tick(); // 15 минут тишины
    expect(reader.mailRead).toHaveBeenCalledTimes(MAIL_MUTE_AFTER_UNKNOWN); // ни одного холостого чтения
    expect(mutedCount()).toBe(1); // и ни одной новой деградации
  });

  it("часовая проба: та же непонятная вкладка — молчим дальше; другая вкладка с узнанной вёрсткой — письма снова идут", async () => {
    const replies: unknown[] = Array.from({ length: MAIL_MUTE_AFTER_UNKNOWN + 1 }, () => UNKNOWN);
    replies.push({ ok: true, recognized: true, host: "mail.google.com", mail: [{ from: "Бухгалтерия", subject: "Акт" }] });
    const { reader, tick } = source(replies);
    for (let k = 0; k < MAIL_MUTE_AFTER_UNKNOWN; k += 1) await tick();

    clock += MAIL_MUTED_PROBE_MS; // проба №1 — та же e.mail.ru
    expect(await tick()).toEqual([]);
    expect(reader.mailRead).toHaveBeenCalledTimes(MAIL_MUTE_AFTER_UNKNOWN + 1);
    expect(mutedCount()).toBe(1);
    await tick(); // до следующей пробы — снова без чтения
    expect(reader.mailRead).toHaveBeenCalledTimes(MAIL_MUTE_AFTER_UNKNOWN + 1);

    clock += MAIL_MUTED_PROBE_MS; // проба №2 — владелец открыл Gmail
    const out = await tick();
    expect(out.map((s) => s.title)).toEqual(["Сэр, вам письмо от Бухгалтерия — «Акт»."]);
    await tick(); // источник снова слушает каждый тик
    expect(reader.mailRead).toHaveBeenCalledTimes(MAIL_MUTE_AFTER_UNKNOWN + 3);
  });

  it("АНТИ-ОВЕРФИТ: серия прерывается узнанной вёрсткой — источник не замолкает", async () => {
    const ok = { ok: true, recognized: true, host: "e.mail.ru", mail: [] };
    const seq = [...Array(MAIL_MUTE_AFTER_UNKNOWN - 1).fill(UNKNOWN), ok, ...Array(MAIL_MUTE_AFTER_UNKNOWN - 1).fill(UNKNOWN)];
    const { reader, tick } = source(seq);
    for (let k = 0; k < seq.length; k += 1) await tick(); // 9 чтений, но подряд — не больше 4
    expect(mutedCount()).toBe(0);
    await tick(); // и следующий тик по-прежнему читает вкладку
    expect(reader.mailRead).toHaveBeenCalledTimes(seq.length + 1);
  });
});
