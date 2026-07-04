import { describe, expect, it } from "vitest";
import { newsQuery } from "./news.js";

describe("news — построитель запроса новостей (§трейдинг)", () => {
  it("крипто-тикер → имя монеты", () => {
    expect(newsQuery("BTCUSDT")).toMatch(/Bitcoin/);
    expect(newsQuery("ethusdt")).toMatch(/Ethereum/);
  });

  it("МосБиржа-тикер → название эмитента", () => {
    expect(newsQuery("SBER")).toMatch(/Сбербанк/);
    expect(newsQuery("GAZP")).toMatch(/Газпром/);
  });

  it("неизвестная крипто-пара → база пары + crypto news", () => {
    expect(newsQuery("PEPEUSDT")).toBe("PEPE crypto news");
  });

  it("неизвестный тикер → акции новости", () => {
    expect(newsQuery("XYZ")).toMatch(/XYZ.*новости/);
  });
});
