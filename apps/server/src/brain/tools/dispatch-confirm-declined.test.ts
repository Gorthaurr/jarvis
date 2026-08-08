/**
 * 🔴 Ф0 пульта, адверс-ревью HIGH: §14-гейт не пропустил действие → результат `isError:false`
 * (это не сбой инструмента), и БЕЗ метки `declined` петля взводила `anyMutateSucceeded` для
 * mutate-инструментов. Следствие: masked-failure и анти-капитуляция отключались, и ход заканчивался
 * «Готово, сэр» при том, что ничего не сделано, а владельца даже не спросили.
 *
 * Здесь проверяем САМ КОНТРАКТ результата (метка + честная формулировка); связку с петлёй держит
 * `agent/index.ts` (`r.declined !== true && …`).
 */
import { describe, expect, it } from "vitest";
import { type ToolContext, dispatchTool } from "./dispatch.js";

type Outcome = "denied" | "expired" | "undelivered";

function ctxWithConfirm(outcome: Outcome): ToolContext {
  return {
    userId: "u1",
    session: { sendAction: async () => ({ commandId: "c1", ok: true, durationMs: 1 }) },
    confirm: async () => ({ approved: false, outcome }),
  } as unknown as ToolContext;
}

describe("§14 отказ гейта помечает результат declined (Ф0)", () => {
  it("fs_delete: отказ владельца → declined, действие НЕ считается выполненным", async () => {
    const r = await dispatchTool("fs_delete", { path: "C:/tmp/x", recursive: false }, ctxWithConfirm("denied"));
    expect(r.isError).toBe(false); // не сбой инструмента
    expect(r.declined).toBe(true); // ← без этого петля решила бы, что дело сделано
    expect(String(r.content)).toMatch(/отменено пользователем/i);
  });

  it("fs_delete: канал недоступен → declined + «не смог спросить» (не приписываем решение владельцу)", async () => {
    const r = await dispatchTool("fs_delete", { path: "C:/tmp/x" }, ctxWithConfirm("undelivered"));
    expect(r.declined).toBe(true);
    expect(String(r.content)).toMatch(/не смог спросить|недоступн/i);
    expect(String(r.content)).not.toMatch(/отменено пользователем/i);
  });

  it("fs_delete: окно истекло → declined + «вы не ответили»", async () => {
    const r = await dispatchTool("fs_delete", { path: "C:/tmp/x" }, ctxWithConfirm("expired"));
    expect(r.declined).toBe(true);
    expect(String(r.content)).toMatch(/не ответили|истекл/i);
  });

  it("code_run с необратимой операцией: отказ → declined", async () => {
    const ctx = ctxWithConfirm("undelivered");
    const r = await dispatchTool("code_run", { lang: "powershell", code: "Remove-Item C:/data -Recurse -Force" }, ctx);
    // Либо гард отклонил код (err), либо дошло до confirm и вернулся declined — но НИКОГДА не «сделано».
    expect(r.isError === true || r.declined === true).toBe(true);
    expect(String(r.content)).not.toMatch(/^ok\b/i);
  });

  it("успешный путь метку НЕ ставит (регресса нет)", async () => {
    const ctx = {
      userId: "u1",
      session: { sendAction: async () => ({ commandId: "c1", ok: true, durationMs: 1, data: "удалено" }) },
      confirm: async () => ({ approved: true, outcome: "approved" as const }),
    } as unknown as ToolContext;
    const r = await dispatchTool("fs_delete", { path: "C:/tmp/x" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.declined).toBeUndefined(); // действие реально выполнено
  });
});

// Контроль-2 Ф0: «канал мёртв» — не провал раунда. Без channelDown петля считала раунд
// провалившимся, эскалировала тир на Opus «от транспорта» и повторно спрашивала владельца.
describe("undelivered помечается channelDown (Б4-ожидание вместо эскалации)", () => {
  it("undelivered → channelDown, петля подождёт reconnect", async () => {
    const r = await dispatchTool("fs_delete", { path: "C:/tmp/x" }, ctxWithConfirm("undelivered"));
    expect(r.declined).toBe(true);
    expect(r.channelDown).toBe(true);
  });

  it("отказ владельца и истечение окна — НЕ channelDown (канал жив, это его решение/молчание)", async () => {
    for (const outcome of ["denied", "expired"] as const) {
      const r = await dispatchTool("fs_delete", { path: "C:/tmp/x" }, ctxWithConfirm(outcome));
      expect(r.declined).toBe(true);
      expect(r.channelDown).toBeUndefined();
    }
  });
});
