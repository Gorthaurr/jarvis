/** Перевод истории без потери tool errors и изображений. Транскрипт — данные, не system. */
import type { LlmRequest, ToolResultContent } from "../llm.js";

export function codexContent(content: string | ToolResultContent[]) {
  return typeof content === "string" ? [{ type: "inputText", text: content }] : content.map((b) =>
    b.type === "text" ? { type: "inputText", text: b.text }
      : { type: "inputImage", imageUrl: `data:${b.source.media_type};base64,${b.source.data}` });
}
export function codexInput(req: LlmRequest): Record<string, unknown>[] {
  const images: Record<string, unknown>[] = [];
  const transcript = req.messages.map((message) => ({ role: message.role,
    content: typeof message.content === "string" ? message.content : message.content.flatMap<Record<string, unknown>>((b) => {
      if (b.type === "thinking" || b.type === "redacted_thinking") return [];
      if (b.type === "image") {
        images.push({ type: "image", url: `data:${b.source.media_type};base64,${b.source.data}` });
        return [{ type: "text", text: `[Изображение ${images.length}, приложено к транскрипту]` }];
      }
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        return [{ ...b, content: b.content.map((item) => {
          if (item.type === "text") return item;
          images.push({ type: "image", url: `data:${item.source.media_type};base64,${item.source.data}` });
          return { type: "text", text: `[Изображение ${images.length}, результат ${b.tool_use_id}]` };
        }) }];
      }
      return [b];
    }),
  }));
  return [{ type: "text", text: `Контекст текущего хода:\n${req.systemDynamic ?? ""}\n\nИстория Jarvis (JSON):\n${JSON.stringify(transcript)}`, text_elements: [] }, ...images];
}
export function codexFingerprint(req: LlmRequest): string {
  return JSON.stringify([req.systemStatic, req.systemSkill, req.systemTools, req.tools]);
}
