/**
 * Рубежи code_run, которые раньше держались ТОЛЬКО прозой (рецепт/персона), а значит не держались
 * вовсе: prompt-инъекция со страницы читает текст как данные и спокойно идёт мимо него.
 *
 * Проверяем РЕАЛЬНЫЙ путь исполнения (dispatchTool → runCodeGuarded → executeGuardedCode), а не
 * чистую функцию гарда: важна именно ПРОВОДКА — доходит ли блок до отказа, а причина подтверждения
 * до владельца. Чистые правила покрыты в brain/code-guard.test.ts.
 */
import { describe, expect, it } from "vitest";
import { type ToolContext, dispatchTool } from "../dispatch.js";

/** Стенд: запоминает, о чём именно спросили владельца, и отвечает заданным исходом. */
function ctx(answer: "approve" | "deny", prompts: string[]): ToolContext {
  return {
    userId: "u1",
    session: { sendAction: async () => ({ commandId: "c1", ok: true, durationMs: 1, data: "ok" }) },
    confirm: async (text: string) => {
      prompts.push(text);
      return answer === "approve" ? { approved: true, outcome: "approved" as const } : { approved: false, outcome: "denied" as const };
    },
  } as unknown as ToolContext;
}

describe("code_run: подпись блокируется, почта — только через владельца", () => {
  it("подпись документа не доходит даже до вопроса владельцу — честный отказ с причиной", async () => {
    const prompts: string[] = [];
    const r = await dispatchTool(
      "code_run",
      { lang: "powershell", code: "Set-AuthenticodeSignature -FilePath C:/docs/dogovor.pdf -Certificate $cert" },
      ctx("approve", prompts),
    );
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/63-ФЗ/); // владельцу объясняем ПОЧЕМУ, а не «нельзя»
    expect(prompts).toHaveLength(0); // подпись не предлагается подтвердить: это не вопрос выбора
  });

  it("отправка письма: владелец видит В ВОПРОСЕ, что речь о письме (а не только первые строки кода)", async () => {
    const prompts: string[] = [];
    // Отправка спрятана в конце длинного скрипта — в модалку влезают лишь первые 160 символов кода.
    const filler = "# сбор отчёта\n".repeat(20);
    const code = `${filler}import smtplib\ns = smtplib.SMTP('smtp.mail.ru', 587)\ns.send_message(msg)`;
    const r = await dispatchTool("code_run", { lang: "python", code }, ctx("deny", prompts));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/письм/i); // ← без причины это было бы подтверждение вслепую
    expect(r.declined).toBe(true); // отказ владельца ≠ «сделано»
    expect(String(r.content)).not.toMatch(/^ok\b/i);
  });

  it("обычный код по-прежнему исполняется без вопросов (гард не парализует работу)", async () => {
    const prompts: string[] = [];
    const r = await dispatchTool("code_run", { lang: "python", code: "print(sum(range(10)))" }, ctx("approve", prompts));
    expect(prompts).toHaveLength(0);
    expect(r.isError).toBe(false);
  });
});
