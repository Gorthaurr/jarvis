/**
 * Актуатор синтетического ввода (мышь/клавиатура) через win-сайдкар (§6).
 *
 * Синтетический ввод (SendInput) — это FALLBACK (§6): основной путь — UIA-паттерны
 * (ground.ts / ui.invoke). input.* используются там, где UIA недоступна (canvas, игры).
 *
 * Реальный SendInput — в нативном сайдкаре apps/sidecar-win (C#/.NET); main общается
 * с ним по stdio JSON-RPC (sidecar-client.ts). Синтетика маркируется (extra-info) —
 * чтобы арбитраж ввода (§6) отличал её от физической активности пользователя.
 * Если сайдкар не поднят — бросаем NotImplementedError (dispatch → runtime-ошибка).
 */
import type { Target } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { sidecar } from "./sidecar-client.js";

const log = createLogger("actuator:input");

function ensure(): void {
  if (!sidecar().ready) throw new NotImplementedError("сайдкар не запущен");
}

/** Печать текста посимвольно с человеческим джиттером в сайдкаре (§3 принцип 3). */
export async function typeText(text: string): Promise<void> {
  ensure();
  log.debug("input.type", { len: text.length });
  await sidecar().request("type", { text });
}

/** combo в нотации протокола: "Ctrl+S", "ArrowRight", "Space". */
export async function pressKey(combo: string): Promise<void> {
  ensure();
  await sidecar().request("key", { combo });
}

/** Клик по цели. coords — vision-fallback; role грундится в handle перед кликом (§6). */
export async function click(target: Target): Promise<void> {
  ensure();
  if (target.by === "coords") {
    await sidecar().request("click", { x: target.x, y: target.y });
  } else if (target.by === "handle") {
    await sidecar().request("click", { handle: target.handle });
  } else {
    // role → ground → click по центру элемента (по handle).
    const g = (await sidecar().request("ground", { role: target.role, name: target.name })) as {
      handle: string;
    };
    await sidecar().request("click", { handle: g.handle });
  }
}

/** Единый маркер «не реализовано/недоступно» — dispatch маппит его в error.runtime. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what}: синтетический ввод недоступен (win-сайдкар apps/sidecar-win)`);
    this.name = "NotImplementedError";
  }
}
