/** Нативный Ollama chat: tool_result остаётся сообщением tool, изображения — отдельными base64. */
import type { LlmRequest } from "./llm.js";

export interface OllamaMessage {
  role: string; content: string; images?: string[]; tool_name?: string; tool_call_id?: string;
  tool_calls?: { id?: string; function: { name: string; arguments: Record<string, unknown> } }[];
}
export function ollamaMessages(req: LlmRequest): OllamaMessage[] {
  const result: OllamaMessage[] = [{ role: "system", content:
    [req.systemStatic, req.systemSkill, req.systemTools, req.systemDynamic].filter(Boolean).join("\n\n") }];
  const names = new Map<string, string>();
  for (const msg of req.messages) {
    if (typeof msg.content === "string") { result.push({ role: msg.role, content: msg.content }); continue; }
    let current: OllamaMessage = { role: msg.role, content: "" };
    const flush = () => {
      if (current.content || current.images?.length || current.tool_calls?.length) result.push(current);
      current = { role: msg.role, content: "" };
    };
    for (const b of msg.content) {
      if (b.type === "text") current.content += b.text;
      if (b.type === "image") (current.images ??= []).push(b.source.data);
      if (b.type === "tool_use") {
        names.set(b.id, b.name);
        (current.tool_calls ??= []).push({ id: b.id, function: { name: b.name, arguments: b.input } });
      }
      if (b.type === "tool_result") {
        flush();
        const contents = typeof b.content === "string" ? [{ type: "text" as const, text: b.content }] : b.content;
        result.push({ role: "tool", tool_name: names.get(b.tool_use_id), tool_call_id: b.tool_use_id,
          content: `${b.is_error ? "[ОШИБКА ИНСТРУМЕНТА]\n" : ""}${contents.filter((v) => v.type === "text").map((v) => v.text).join("\n")}`,
          images: contents.filter((v) => v.type === "image").map((v) => v.source.data) });
      }
    }
    flush();
  }
  return result;
}
