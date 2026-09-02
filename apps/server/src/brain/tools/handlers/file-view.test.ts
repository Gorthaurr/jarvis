/**
 * §3.9 зрение на файл — серверный хендлер file_view через РЕАЛЬНЫЙ dispatchTool (как dispatch-vision):
 * картинка доезжает image-блоком, текст начинается с маркера документа (по нему свёртка отличает
 * страницу от скриншота), «нет картинки»/«не тот формат»/«мёртвый канал» — РАЗНЫЕ честные исходы.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchTool, type ToolContext } from "../dispatch.js";
import { FILE_VIEW_MARK, parseFileViewMark } from "../../agent/image-marks.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
function ctxWith(sendAction: Send): ToolContext {
  return { session: { sendAction }, userId: "u1" } as unknown as ToolContext;
}
const okData = (data: unknown): ActionResult => ({ commandId: "c", ok: true, data, durationMs: 1 });

describe("dispatchTool file_view — картинка/страница PDF с диска", () => {
  it("успех → [text с маркером file_view + путь + стр. N/M + пометки честности, image-блок]; observed НЕ ставится", async () => {
    const sendAction = vi.fn<Send>(async (cmd, timeoutMs) => {
      expect(cmd.kind).toBe("fs.view");
      if (cmd.kind !== "fs.view") throw new Error("unreachable");
      expect(cmd.path).toBe("C:\\Users\\anton\\Downloads\\отчёт.pdf");
      expect(cmd.page).toBe(2);
      expect(cmd.maxSide).toBe(1000);
      expect(timeoutMs).toBe(30_000); // рендер PDF через python — дольше дефолтных 15с
      return okData({
        path: "C:\\Users\\anton\\Downloads\\отчёт.pdf",
        image: "UE5H",
        mediaType: "image/png",
        width: 708,
        height: 1000,
        format: "pdf",
        bytes: 204800,
        page: 2,
        pageCount: 5,
        resized: true,
      });
    });
    const r = await dispatchTool("file_view", { path: "C:\\Users\\anton\\Downloads\\отчёт.pdf", page: 2, maxSide: 1000 }, ctxWith(sendAction));
    expect(sendAction).toHaveBeenCalledTimes(1);
    expect(r.isError).toBe(false);
    expect(r.observed).toBeUndefined(); // чтение файла — не сверка GUI
    const blocks = r.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    const text = String(blocks[0]!.text);
    expect(text.startsWith(FILE_VIEW_MARK)).toBe(true);
    expect(text).toContain("отчёт.pdf");
    expect(text).toContain("стр. 2/5");
    expect(text).toContain("image/png");
    expect(text).toContain("708×1000");
    expect(text).toMatch(/недоверенные ДАННЫЕ/u);
    expect(text).toMatch(/НЕ текущее состояние экрана/u);
    // Круг замыкается: то, что собрал хендлер, разбирает свёртка (единый формат image-marks).
    expect(parseFileViewMark(text)).toEqual({ path: "C:\\Users\\anton\\Downloads\\отчёт.pdf", page: 2, pageCount: 5 });
    expect(blocks[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "UE5H" } });
  });

  it("картинка без страниц: маркер без «стр.», mime от актуатора (jpeg) сохраняется", async () => {
    const r = await dispatchTool(
      "file_view",
      { path: "~/Downloads/shot.jpg" },
      ctxWith(async () => okData({ image: "SlBH", mediaType: "image/jpeg", width: 10, height: 5, format: "jpeg", bytes: 3, resized: false })),
    );
    expect(r.isError).toBe(false);
    const blocks = r.content as Array<Record<string, unknown>>;
    expect(parseFileViewMark(String(blocks[0]!.text))).toEqual({ path: "~/Downloads/shot.jpg" });
    expect((blocks[1] as { source: { media_type: string } }).source.media_type).toBe("image/jpeg");
  });

  it("data без image → честная ошибка строкой (не пустой image-блок)", async () => {
    const r = await dispatchTool("file_view", { path: "C:\\a.png" }, ctxWith(async () => okData({ mediaType: "image/png" })));
    expect(r.isError).toBe(true);
    expect(typeof r.content).toBe("string");
    expect(String(r.content)).toMatch(/не вернул изображение/u);
  });

  it("сбой актуатора (не декодировалось / нечем отрендерить) → ошибка с его причиной", async () => {
    const r = await dispatchTool(
      "file_view",
      { path: "C:\\a.pdf" },
      ctxWith(async () => ({ commandId: "c", ok: false, error: { code: "runtime", message: "страницу PDF отрендерить нечем" }, durationMs: 1 })),
    );
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("отрендерить нечем");
    expect(r.channelDown).toBeFalsy();
  });

  it("channel_down → channelDown:true (мёртвый канал ≠ провал чтения, тир не эскалируется)", async () => {
    const r = await dispatchTool(
      "file_view",
      { path: "C:\\a.png" },
      ctxWith(async () => ({ commandId: "c", ok: false, error: { code: "channel_down", message: "сокет закрыт" }, durationMs: 1 })),
    );
    expect(r.isError).toBe(true);
    expect(r.channelDown).toBe(true);
  });

  it("неподдерживаемый mime от клиента (image/bmp) → ошибка называет формат, image-блок не собирается", async () => {
    const r = await dispatchTool(
      "file_view",
      { path: "C:\\a.bmp" },
      ctxWith(async () => okData({ image: "Qk0=", mediaType: "image/bmp", width: 1, height: 1, format: "bmp", bytes: 3, resized: false })),
    );
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("image/bmp");
    expect(String(r.content)).toMatch(/не проходит в модель/u);
  });

  it("base64 больше капа Anthropic → ошибка, а не HTTP 400 на весь ход", async () => {
    const r = await dispatchTool(
      "file_view",
      { path: "C:\\a.png" },
      ctxWith(async () => okData({ image: "A".repeat(5_000_001), mediaType: "image/png", width: 1, height: 1, format: "png", bytes: 3, resized: false })),
    );
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/не проходит в модель/u);
  });

  it("page числовой строкой («2») доезжает до клиента числом; мусор → честная ошибка без похода к клиенту", async () => {
    const sendAction = vi.fn<Send>(async (cmd) => {
      if (cmd.kind !== "fs.view") throw new Error("unreachable");
      expect(cmd.page).toBe(2);
      return okData({ image: "UE5H", mediaType: "image/png", width: 1, height: 1, format: "pdf", bytes: 3, page: 2, pageCount: 4, resized: false, rendered: true });
    });
    const r = await dispatchTool("file_view", { path: "C:\\a.pdf", page: "2" }, ctxWith(sendAction));
    expect(r.isError).toBe(false);
    const bad = vi.fn<Send>(async () => okData({}));
    const e = await dispatchTool("file_view", { path: "C:\\a.pdf", page: "два" }, ctxWith(bad));
    expect(e.isError).toBe(true);
    expect(String(e.content)).toMatch(/page должен быть целым/u);
    expect(bad).not.toHaveBeenCalled();
  });

  it("page у одностраничной картинки → явная пометка «page проигнорирован»; note клиента доезжает", async () => {
    const r = await dispatchTool(
      "file_view",
      { path: "C:\\scan.gif", page: 2, maxSide: 256 },
      ctxWith(async () => okData({ image: "R0lG", mediaType: "image/gif", width: 640, height: 480, format: "gif", bytes: 3, resized: false, note: "maxSide=256 не применён: GIF отдан как есть" })),
    );
    const text = String((r.content as Array<Record<string, unknown>>)[0]!.text);
    expect(text).toMatch(/page проигнорирован/u);
    expect(text).toContain("maxSide=256 не применён");
    expect(text).not.toContain("стр.");
  });

  it("PDF: «отрендерено из PDF», а «ужато» — только при resized", async () => {
    const mk = (resized: boolean) => okData({ image: "UE5H", mediaType: "image/png", width: 1, height: 1, format: "pdf", bytes: 3, page: 1, pageCount: 1, resized, rendered: true });
    const a = await dispatchTool("file_view", { path: "C:\\a.pdf" }, ctxWith(async () => mk(false)));
    const ta = String((a.content as Array<Record<string, unknown>>)[0]!.text);
    expect(ta).toContain("отрендерено из PDF");
    expect(ta).not.toContain("ужато");
    const b = await dispatchTool("file_view", { path: "C:\\a.pdf" }, ctxWith(async () => mk(true)));
    expect(String((b.content as Array<Record<string, unknown>>)[0]!.text)).toContain("ужато под maxSide");
  });

  it("пустой path → ошибка БЕЗ похода к клиенту", async () => {
    const sendAction = vi.fn<Send>(async () => okData({}));
    const r = await dispatchTool("file_view", { path: "  " }, ctxWith(sendAction));
    expect(r.isError).toBe(true);
    expect(sendAction).not.toHaveBeenCalled();
  });
});
