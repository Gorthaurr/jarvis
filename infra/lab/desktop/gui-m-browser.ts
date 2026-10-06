import { loadPage, NEWTAB, normalizeAddress } from "./gui-browser-pages.js";
export { loadPage,NEWTAB,normalizeAddress } from "./gui-browser-pages.js";
/**
 * Браузер (chrome/edge/firefox): вкладки, адресная строка, история. Страницы берутся из `seed.web` ядра (адрес → HTML);
 * адреса вне seed — «оффлайн»: вкладка с именем хоста и честным текстом ошибки. Разметки и ссылок внутри страницы нет —
 * руки во вкладках у Джарвиса и так через расширение (W1), а не через GUI.
 */
import type { DesktopWindow } from "../lib/contracts.js";
import type { Ctx, Model, NodeSpec } from "./gui-model.js";
import { at, parseCombo } from "./gui-model.js";
import { ActionError } from "./gui-state.js";
import { closeWin } from "./gui-winops.js";

const BRAND: Record<string, string> = { chrome: "Google Chrome", msedge: "Microsoft Edge", firefox: "Mozilla Firefox", brave: "Brave", opera: "Opera", browser: "Yandex", vivaldi: "Vivaldi" };

interface Tab {
  url: string;
  title: string;
  text: string;
  back: string[];
  fwd: string[];
}

export function browserModel(ctx: Ctx, w: DesktopWindow, startUrl?: string): Model {
  const { core } = ctx;
  const brand = BRAND[w.process.toLowerCase().replace(/\.exe$/u, "")] ?? "Chrome";
  const tabs: Tab[] = [];
  let active = 0;
  let addrFocus = false;
  let addrText = "";
  let selAll = false;
  const cur = (): Tab => tabs[active]!;
  const apply = (): void => {
    w.title = `${cur().title} - ${brand}`;
    w.text = cur().text;
  };
  const nav = (tab: Tab, url: string, push: boolean): void => {
    if (push && tab.url) {
      tab.back.push(tab.url);
      tab.fwd = [];
    }
    const p = loadPage(core, url);
    tab.url = url;
    tab.title = p.title;
    tab.text = p.text;
    core.effect("browser.navigate", { hwnd: w.hwnd, url, title: p.title, loaded: p.loaded });
    apply();
  };
  const newTab = (url = NEWTAB): void => {
    tabs.push({ url: "", title: "", text: "", back: [], fwd: [] });
    active = tabs.length - 1;
    nav(cur(), url, false);
    core.effect("browser.tab.new", { hwnd: w.hwnd, url });
  };
  const submit = (): void => {
    addrFocus = false;
    nav(cur(), normalizeAddress(addrText), true);
  };
  const step = (dir: -1 | 1): void => {
    const t = cur();
    const to = dir < 0 ? t.back.pop() : t.fwd.pop();
    if (!to) return;
    (dir < 0 ? t.fwd : t.back).push(t.url);
    nav(t, to, false);
  };
  const focusAddr = (): void => {
    addrFocus = true;
    addrText = cur().url === NEWTAB ? "" : cur().url;
    selAll = true;
  };

  const m: Model = {
    kind: "browser",
    nodes(): NodeSpec[] {
      const t = cur();
      const out: NodeSpec[] = tabs.map((x, i) => ({ id: `tab:${i}`, role: "tabitem", name: x.title, ...at(w, i * 200, 0, 200, 30), interactive: true }));
      out.push({ id: "newtab", role: "button", name: "Новая вкладка", label: "+", ...at(w, tabs.length * 200, 0, 30, 30), interactive: true });
      out.push({ id: "back", role: "button", name: "Назад", label: "", ...at(w, 6, 34, 30, 30), interactive: true });
      out.push({ id: "fwd", role: "button", name: "Вперёд", label: "", ...at(w, 40, 34, 30, 30), interactive: true });
      out.push({ id: "reload", role: "button", name: "Обновить", label: "", ...at(w, 74, 34, 30, 30), interactive: true });
      out.push({ id: "addr", role: "edit", name: "Адресная строка и строка поиска", automationId: "omnibox", value: addrFocus ? addrText : t.url === NEWTAB ? "" : t.url, ...at(w, 110, 34, w.rect.w - 130, 30), interactive: true });
      out.push({ id: "doc", role: "document", name: t.title, value: t.text, ...at(w, 0, 70, w.rect.w, w.rect.h - 32 - 70), interactive: true });
      return out;
    },
    focusId: () => (addrFocus ? "addr" : "doc"),
    press(id) {
      if (id.startsWith("tab:")) return void ((active = Number(id.slice(4))), (addrFocus = false), apply());
      if (id === "newtab") return (newTab(), focusAddr());
      if (id === "back") return step(-1);
      if (id === "fwd") return step(1);
      if (id === "reload") return nav(cur(), cur().url, false);
      m.focus(id);
    },
    setValue(id, v) {
      if (id !== "addr") throw new ActionError("ValuePattern не поддержан этим элементом", "runtime");
      addrText = v;
      submit();
    },
    type(text) {
      if (!addrFocus) return false;
      const [line] = text.split("\n");
      addrText = (selAll ? "" : addrText) + (line ?? "");
      selAll = false;
      if (text.includes("\n")) submit();
      return true;
    },
    key(combo) {
      const k = parseCombo(combo);
      if ((k.ctrl && k.key === "l") || k.key === "f6" || (k.alt && k.key === "d")) return (focusAddr(), true);
      if (k.ctrl && k.key === "t") return (newTab(), focusAddr(), true);
      if (k.ctrl && k.key === "w") {
        core.effect("browser.tab.close", { hwnd: w.hwnd, url: cur().url });
        if (tabs.length === 1) return (void closeWin(ctx, w, false, "ctrl+w"), true);
        tabs.splice(active, 1);
        active = Math.min(active, tabs.length - 1);
        return (apply(), true);
      }
      if (k.ctrl && (k.key === "tab" || k.key === "pagedown")) return ((active = (active + 1) % tabs.length), apply(), true);
      if (k.key === "f5" || (k.ctrl && k.key === "r")) return (nav(cur(), cur().url, false), true);
      if (k.alt && k.key === "arrowleft") return (step(-1), true);
      if (k.alt && k.key === "arrowright") return (step(1), true);
      if (!addrFocus) return false;
      if (k.key === "enter") return (submit(), true);
      if (k.key === "escape") return ((addrFocus = false), true);
      if (k.ctrl && k.key === "a") return ((selAll = true), true);
      if (k.ctrl && k.key === "v") return ((addrText = (selAll ? "" : addrText) + core.clipboard), (selAll = false), true);
      if (k.key === "backspace") return ((addrText = selAll ? "" : addrText.slice(0, -1)), (selAll = false), true);
      return false;
    },
    focus(id) {
      if (id === "addr") return focusAddr();
      addrFocus = false;
    },
    selectedText: () => (addrFocus && selAll ? addrText : ""),
  };
  if (startUrl === undefined) {
    // Окно из seed: заголовок/текст заданы снаружи и не затираются; адрес неизвестен (пустая строка).
    const title = w.title.replace(/\s[-—–]\s*(Google Chrome|Microsoft Edge|Mozilla Firefox|Brave|Opera|Yandex|Vivaldi)$/u, "");
    tabs.push({ url: "", title: title || "Новая вкладка", text: w.text, back: [], fwd: [] });
  } else {
    tabs.push({ url: "", title: "", text: "", back: [], fwd: [] });
    nav(cur(), startUrl, false);
  }
  return Object.assign(m, { openUrlInNewTab: (url: string) => newTab(url) });
}

/** Модель браузера с возможностью «открыть ссылку новой вкладкой» (default-browser открытие в существующем окне). */
export type BrowserModel = Model & { openUrlInNewTab(url: string): void };
