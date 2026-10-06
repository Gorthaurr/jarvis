/** Обвязка тестов системной половины FakeDesktop: ядро + таблица обработчиков напрямую, без сокета и сервера. */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { type DesktopCore, createDesktopCore } from "./core.js";
import type { DesktopSeed } from "../lib/contracts.js";
import { systemHandlers } from "./system-handlers.js";

export interface Kit {
  core: DesktopCore;
  call(cmd: ActionCommand): Promise<ActionResult>;
  /** Успешный ответ → data; провал → тест падает с текстом ошибки. */
  data<T = Record<string, unknown>>(cmd: ActionCommand): Promise<T>;
  /** Провал → текст ошибки (код обязан быть runtime, как у клиента); успех → тест падает. */
  err(cmd: ActionCommand): Promise<string>;
  put(path: string, content: string | Buffer): void;
  file(path: string): Buffer | undefined;
}

export function makeKit(seed?: DesktopSeed): Kit {
  const core = createDesktopCore(seed);
  const table = systemHandlers(core, async (_c, m) => core.ok(m.commandId));
  let n = 0;
  const call = async (cmd: ActionCommand): Promise<ActionResult> => {
    const h = table[cmd.kind];
    if (!h) throw new Error(`нет обработчика ${cmd.kind}`);
    return await h(cmd, { commandId: `t${++n}`, timeoutMs: 1000 });
  };
  return {
    core,
    call,
    async data<T>(cmd: ActionCommand) {
      const r = await call(cmd);
      if (!r.ok) throw new Error(`${cmd.kind}: ожидался успех, а ${r.error?.code}: ${r.error?.message}`);
      return r.data as T;
    },
    async err(cmd: ActionCommand) {
      const r = await call(cmd);
      if (r.ok) throw new Error(`${cmd.kind}: ожидалась ошибка, а пришло ${JSON.stringify(r.data)}`);
      if (r.error?.code !== "runtime") throw new Error(`код ошибки ${r.error?.code}, у клиента для fs/system/audio всегда runtime`);
      return r.error.message;
    },
    put(path, content) {
      const p = path.replace(/\\/gu, "/");
      core.fs.files.set(p, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
      let d = p.slice(0, p.lastIndexOf("/"));
      while (d.length > 2) { core.fs.dirs.add(d); d = d.slice(0, d.lastIndexOf("/")); }
    },
    file: (path) => core.fs.files.get(path.replace(/\\/gu, "/")),
  };
}
