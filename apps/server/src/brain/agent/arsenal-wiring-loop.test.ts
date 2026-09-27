/**
 * W3 пакет C (L-8, L-10) в ПЕТЛЕ: handleUserText → первый запрос к модели и настоящий dispatchTool.
 *  - каталог холодных в systemTools — новые строки (предусловие web_login/app_channel_learn), без обрубков;
 *  - web_read в горячем наборе знает view:"elements"; вызов web_read{view:"elements", query} уходит клиенту как
 *    jbrowser.inspect с query (глаза невидимого браузера — горячим путём), текст страницы — jbrowser.read без полей;
 *  - объект tool_use провайдера не мутируется (канал подписки сопоставляет хендлер по нему).
 * Реверт-проверка (сделана): старый toolCatalogLine — падает первый; убрать case "web_read" из facades — второй.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { TOOLS_BY_NAME, toolCatalogLine } from "@jarvis/tools";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

function session() {
  const sendAction = vi.fn((cmd: ActionCommand) =>
    Promise.resolve(
      cmd.kind === "jbrowser.inspect"
        ? { commandId: "c", ok: true, data: { url: "https://mail.example/", elements: [{ selector: "#login", role: "button", text: "Войти" }] }, durationMs: 1 }
        : cmd.kind === "jbrowser.read"
          ? { commandId: "c", ok: true, data: { url: "https://mail.example/", title: "Почта", text: "Входящие: 3" }, durationMs: 1 }
          : { commandId: "c", ok: true, durationMs: 1 },
    ),
  );
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
}
function deps(llm: MockLlmProvider): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
  };
}
const cmds = (s: Session): ActionCommand[] => (s.sendAction as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as ActionCommand);

describe("арсенал W3 в петле", () => {
  it("первый запрос к модели: каталог холодных — новые строки с предусловием; web_read в tools[] знает view elements", async () => {
    const llm = new MockLlmProvider([{ text: "Хорошо, сэр." }]);
    await handleUserText(session(), "зайди в почту и посмотри, что там", deps(llm));
    const req = llm.requests[0]!;
    const catalog = String(req.systemTools ?? "");
    expect(catalog).toContain(toolCatalogLine(TOOLS_BY_NAME["web_login"]!));
    expect(catalog).toContain(toolCatalogLine(TOOLS_BY_NAME["app_channel_learn"]!));
    expect(catalog).toMatch(/- web_login: [^\n]*входит сам/u);
    expect(catalog).not.toMatch(/- web_login: ВХОД В СЕРВИС\n/u); // прежний обрубок первой фразы
    const webRead = (req.tools ?? []).find((t) => t.name === "web_read");
    expect(JSON.stringify(webRead?.input_schema)).toContain("elements");
  });

  it("web_read{view:'elements', query} → jbrowser.inspect с query клиенту; web_read{} → jbrowser.read без полей; tool_use не тронут", async () => {
    const eyes = { id: "r1", name: "web_read", input: { view: "elements", query: "Войти" } };
    const llm = new MockLlmProvider([
      { toolUses: [eyes] },
      { toolUses: [{ id: "r2", name: "web_read", input: { view: "text" } }] },
      { text: "Во входящих три письма, сэр." },
    ]);
    const s = session();
    await handleUserText(s, "зайди в почту и посмотри, что там", deps(llm));
    const sent = cmds(s);
    expect(sent.find((c) => c.kind === "jbrowser.inspect")).toMatchObject({ kind: "jbrowser.inspect", query: "Войти" });
    const read = sent.find((c) => c.kind === "jbrowser.read") as Record<string, unknown> | undefined;
    expect(read).toBeDefined();
    expect(read).not.toHaveProperty("view");
    expect(eyes).toEqual({ id: "r1", name: "web_read", input: { view: "elements", query: "Войти" } });
    // результат глаз дошёл до модели недоверенным блоком (страница — внешний контент)
    expect(JSON.stringify(llm.requests[1]!.messages)).toMatch(/untrusted_content[^]*#login/u);
  });
});
