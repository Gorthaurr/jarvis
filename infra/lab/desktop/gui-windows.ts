/**
 * Окна и приложения: app.launch/focus/close, browser.open, window.list/focus/arrange. Формы data и коды ошибок — как у
 * настоящих актуаторов (app.focus без окна → not_found, app.close при closed=0 → not_found, window.* → runtime).
 */
import type { DesktopWindow } from "../lib/contracts.js";
import type { DesktopCore, KindHandlers } from "./core.js";
import { CRITICAL, launch, matchesProcess, resolveName } from "./gui-apps.js";
import { guarded } from "./gui-run.js";
import { veilGate } from "./gui-input.js";
import type { Ctx } from "./gui-model.js";
import { ActionError, monitorIndexOf, monitorLabel, raise, tick, zOrder } from "./gui-state.js";
import { closeWin, isMaximized, maximizeWin, minimizeWin, moveWin, restoreWin, windowInfo } from "./gui-winops.js";

const findByQuery = (ctx: Ctx, q: string): DesktopWindow | undefined => {
  const s = q.trim().toLowerCase();
  return zOrder(ctx.core, ctx.st).find((w) => w.title.toLowerCase().includes(s) || w.process.toLowerCase().includes(s));
};

function launchData(ctx: Ctx, info: ReturnType<typeof launch>): Record<string, unknown> {
  return {
    resolved: info.resolved,
    pid: info.w.pid,
    display: info.display,
    kind: info.kind,
    source: info.kind === "exe" ? "AppPaths" : info.kind,
    confirmed: true,
    verified: info.reused ? "appid-already" : "process",
    window: { hwnd: info.w.hwnd, title: info.w.title },
    windowSeen: true,
  };
}

const focusFields = (ctx: Ctx, w: DesktopWindow): Record<string, unknown> => {
  const many = ctx.core.monitors.length > 1;
  const i = monitorIndexOf(ctx.core, w);
  return { monitorIndex: i, ...(many ? { monitor: monitorLabel(ctx.core, i) } : {}) };
};

export function windowHandlers(core: DesktopCore): KindHandlers {
  return {
    "app.launch": guarded<"app.launch">(core, (cmd, ctx) => {
      const info = launch(ctx, cmd.app);
      core.effect("app.launch", { app: cmd.app, pid: info.w.pid, process: info.w.process, hwnd: info.w.hwnd, reused: info.reused });
      return launchData(ctx, info);
    }),

    "browser.open": guarded<"browser.open">(core, (cmd, ctx) => {
      const info = launch(ctx, cmd.url);
      core.effect("app.launch", { app: cmd.url, pid: info.w.pid, process: info.w.process, hwnd: info.w.hwnd, reused: info.reused, browser: true });
      // inDefault — ДЕФОЛТНЫЙ браузер владельца (его вкладка); иначе управляемый инстанс (CDP): {url, controlled:true}.
      return cmd.inDefault ? { ...launchData(ctx, info), url: cmd.url, controlled: false, inDefault: true } : { url: cmd.url, controlled: true };
    }),

    "app.focus": guarded<"app.focus">(core, (cmd, ctx) => {
      const target = resolveName(core, cmd.app);
      const w = zOrder(core, ctx.st).find((x) => matchesProcess(x.process, cmd.app) || x.title.toLowerCase().includes(cmd.app.trim().toLowerCase()));
      if (!w) throw new ActionError(`не сфокусировал «${cmd.app}»: приложение не запущено или окно не вышло на передний план. Запусти его (app_launch) или проверь имя.`, "not_found");
      veilGate(ctx, "Смена фокуса окна отобрала бы клавиатуру у окна рисования.");
      raise(core, ctx.st, w);
      core.effect("window.focus", { hwnd: w.hwnd, title: w.title, process: w.process, via: "app.focus" });
      tick(core, 50);
      return { resolved: target, focused: true };
    }),

    "app.close": guarded<"app.close">(core, (cmd, ctx) => {
      const target = resolveName(core, cmd.app);
      if (CRITICAL.has(target.toLowerCase().replace(/\.exe$/u, ""))) throw new ActionError(`нельзя закрыть «${cmd.app}»: это сам Джарвис или критический системный процесс`, "runtime");
      if (/[*?]/u.test(target)) throw new ActionError(`нельзя закрыть «${cmd.app}»: имя процесса не должно содержать * или ?`, "runtime");
      const pids = [...new Set([...core.windows.values()].filter((w) => matchesProcess(w.process, cmd.app)).map((w) => w.pid))];
      for (const pid of pids) {
        for (const w of [...core.windows.values()].filter((x) => x.pid === pid)) closeWin(ctx, w, cmd.force === true, "app.close");
      }
      const closed = pids.filter((pid) => ![...core.windows.values()].some((w) => w.pid === pid)).length;
      core.effect("app.close", { app: cmd.app, closed, force: cmd.force === true });
      tick(core, cmd.force ? 500 : 1600);
      if (closed === 0) {
        throw new ActionError(`не закрыл «${cmd.app}»: подходящий запущенный процесс не найден или не закрылся штатно. Проверь имя процесса или повтори с force=true (жёсткое закрытие).`, "not_found");
      }
      return { resolved: target, closed };
    }),

    "window.list": guarded<"window.list">(core, (_cmd, ctx) => ({ windows: zOrder(core, ctx.st).map((w) => windowInfo(ctx, w)) })),

    "window.focus": guarded<"window.focus">(core, (cmd, ctx) => {
      veilGate(ctx, "Смена фокуса окна отобрала бы клавиатуру у окна рисования.");
      if (cmd.hwnd === undefined && !cmd.query?.trim()) throw new ActionError("window.focus: нужен hwnd (из window_list) или query (подстрока заголовка/процесса)", "runtime");
      const w = cmd.hwnd !== undefined ? core.windows.get(cmd.hwnd) : findByQuery(ctx, cmd.query!);
      if (!w) throw new ActionError(`фокус не взят: Окно не найдено: ${cmd.hwnd ?? cmd.query}. Проверь имя/hwnd через window_list.`, "runtime");
      raise(core, ctx.st, w);
      core.effect("window.focus", { hwnd: w.hwnd, title: w.title, process: w.process, via: "window.focus" });
      tick(core, 50);
      return { focused: true, hwnd: w.hwnd, title: w.title, ...focusFields(ctx, w) };
    }),

    "window.arrange": guarded<"window.arrange">(core, (cmd, ctx) => {
      const q = (cmd.query ?? "").trim().toLowerCase();
      const w = (cmd.hwnd ? core.windows.get(cmd.hwnd) : undefined) ?? (q ? findByQuery(ctx, q) : undefined);
      if (!w) throw new ActionError(cmd.hwnd ? `окна с hwnd ${cmd.hwnd} нет — перечитай window_list` : `окно «${cmd.query ?? ""}» не найдено среди открытых — проверь window_list`, "runtime");
      if (cmd.op !== "minimize") veilGate(ctx, "Перестановка окна отобрала бы клавиатуру у окна рисования.");
      if (cmd.op === "minimize") minimizeWin(ctx, w);
      else if (cmd.op === "maximize") maximizeWin(ctx, w);
      else if (cmd.op === "restore") restoreWin(ctx, w);
      else {
        if (cmd.monitor === undefined) throw new ActionError("для переноса нужен индекс монитора (monitor)", "runtime");
        moveWin(ctx, w, cmd.monitor, cmd.maximizeAfterMove === true);
      }
      tick(core, 150);
      const idx = w.minimized ? null : monitorIndexOf(core, w);
      return { hwnd: w.hwnd, minimized: w.minimized, maximized: isMaximized(w), rect: { ...w.rect }, monitorIndex: idx, monitor: w.minimized ? "свёрнуто" : monitorLabel(core, idx!), title: w.title, process: w.process };
    }),
  };
}
