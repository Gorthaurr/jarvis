import { type DomNode, find, innerText } from "./service-dom.js";
export class PageFail extends Error {
  constructor(readonly code: "not_found" | "denied" | "runtime", message: string, readonly data?: unknown, readonly injected = false) {
    super(message);
  }
}
export interface Page {
  url: string;
  root: DomNode;
  focused?: DomNode;
  scrollY: number;
}
/** Навигация из действия: страница или причина, почему перейти нельзя (внутренний адрес / нет в seed.web). */
export type Navigate = (url: string) => { page: Page } | { blocked: string } | { missing: string };

export const fold = (s: unknown): string => String(s ?? "").toLowerCase().replace(/ё/gu, "е").replace(/[.,!?;:()"'«»\-—–]+/gu, " ").replace(/\s+/gu, " ").trim();
export const oneLine = (s: string): string => s.replace(/\s+/gu, " ").trim();
export const typeOf = (n: DomNode): string => (n.attrs.type ?? "").toLowerCase();
export const SECRET = "secret_field: поле пароля/кода/карты — вводит владелец сам (§0), страница его не заполняет";

export const isSecret = (n: DomNode): boolean => n.tag === "input" && (typeOf(n) === "password" || /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[a-z-]+)(?:\s|$)/iu.test(n.attrs.autocomplete ?? ""));
export const editable = (n: DomNode): boolean => n.tag === "textarea" || n.attrs.contenteditable === "true" || (n.tag === "input" && !/^(checkbox|radio|submit|button|reset|image|file|hidden|range|color)$/u.test(typeOf(n)));
export const formOf = (n: DomNode): DomNode | undefined => {
  for (let p: DomNode | undefined = n; p; p = p.parent) if (p.tag === "form") return p;
  return undefined;
};
export const isSubmit = (n: DomNode): boolean => (n.tag === "button" && (typeOf(n) === "" || typeOf(n) === "submit")) || (n.tag === "input" && (typeOf(n) === "submit" || typeOf(n) === "image"));

export const INTERACTIVE_ROLES = new Set(["button", "link", "tab", "menuitem", "option", "checkbox", "radio", "switch", "combobox"]);
export function isInteractive(n: DomNode): boolean {
  if (n.tag === "#text" || n.tag === "#root") return false;
  return (n.tag === "a" && "href" in n.attrs) || ["button", "input", "select", "textarea", "summary"].includes(n.tag) || INTERACTIVE_ROLES.has(n.attrs.role ?? "") || n.attrs.contenteditable === "true" || "onclick" in n.attrs || ("tabindex" in n.attrs && n.attrs.tabindex !== "-1") || "aria-label" in n.attrs;
}

/** Подписи элемента по отдельности (accname-подмножество): по ним ищут цель и судит гард §14. */
export function labelParts(root: DomNode, n: DomNode): string[] {
  const parts = [n.attrs["aria-label"] ?? "", n.attrs.title ?? ""];
  const byFor = n.attrs.id ? find(root, (x) => x.tag === "label" && x.attrs.for === n.attrs.id) : undefined;
  if (byFor) parts.push(innerText(byFor));
  for (let p = n.parent; p; p = p.parent) if (p.tag === "label") parts.push(innerText(p));
  if (n.tag === "input" || n.tag === "textarea") {
    parts.push(n.attrs.placeholder ?? "");
    if (/^(submit|button|reset|image)$/u.test(typeOf(n))) parts.push(n.attrs.value ?? "", n.attrs.alt ?? "");
  } else if (n.tag !== "select") parts.push(innerText(n));
  return parts.map(oneLine).filter(Boolean);
}
