import { describe, expect, it } from "vitest";
import { JsonLineRpc, type RpcRequest } from "./sidecar-client.js";

describe("JsonLineRpc (§6 IPC)", () => {
  it("корреляция запрос↔ответ по id", async () => {
    const sent: string[] = [];
    const rpc = new JsonLineRpc((line) => sent.push(line));
    const p = rpc.request("ground", { role: "button", name: "OK" });

    const req = JSON.parse(sent[0]!.trim()) as RpcRequest;
    expect(req.op).toBe("ground");
    expect(req.args).toEqual({ role: "button", name: "OK" });

    rpc.feed(`${JSON.stringify({ id: req.id, ok: true, data: { handle: "h1", bbox: { x: 0, y: 0, w: 10, h: 10 } } })}\n`);
    await expect(p).resolves.toEqual({ handle: "h1", bbox: { x: 0, y: 0, w: 10, h: 10 } });
  });

  it("собирает ответ из частичных чанков (split по \\n)", async () => {
    const sent: string[] = [];
    const rpc = new JsonLineRpc((line) => sent.push(line));
    const p = rpc.request("type", { text: "hi" });
    const id = (JSON.parse(sent[0]!.trim()) as RpcRequest).id;
    const full = `${JSON.stringify({ id, ok: true, data: null })}\n`;
    rpc.feed(full.slice(0, 5));
    rpc.feed(full.slice(5));
    await expect(p).resolves.toBeNull();
  });

  it("ok:false → reject с сообщением", async () => {
    const sent: string[] = [];
    const rpc = new JsonLineRpc((line) => sent.push(line));
    const p = rpc.request("invoke", {});
    const id = (JSON.parse(sent[0]!.trim()) as RpcRequest).id;
    rpc.feed(`${JSON.stringify({ id, ok: false, error: "элемент не найден" })}\n`);
    await expect(p).rejects.toThrow("элемент не найден");
  });

  it("таймаут отклоняет запрос", async () => {
    const rpc = new JsonLineRpc(() => {});
    await expect(rpc.request("ground", {}, 10)).rejects.toThrow(/timeout/);
  });

  it("несколько одновременных запросов резолвятся независимо", async () => {
    const sent: string[] = [];
    const rpc = new JsonLineRpc((line) => sent.push(line));
    const p1 = rpc.request("a", {});
    const p2 = rpc.request("b", {});
    const id1 = (JSON.parse(sent[0]!.trim()) as RpcRequest).id;
    const id2 = (JSON.parse(sent[1]!.trim()) as RpcRequest).id;
    rpc.feed(`${JSON.stringify({ id: id2, ok: true, data: 2 })}\n${JSON.stringify({ id: id1, ok: true, data: 1 })}\n`);
    await expect(p1).resolves.toBe(1);
    await expect(p2).resolves.toBe(2);
  });
});
