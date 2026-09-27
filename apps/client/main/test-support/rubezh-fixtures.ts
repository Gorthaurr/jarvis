/**
 * W2 П1: фикстуры рубежа инжекции в РЕАЛЬНОЙ форме сайдкара — окна (window.list: физический rect, z-порядок сверху
 * вниз, pid/hwnd/foreground), элементы снапшота (handle числом, роль короткая) и одобрение сервера (гранты + срок).
 */
import type { CommitApproval, CommitGrant } from "@jarvis/protocol";
import type { FakeElement, FakeWindow } from "./fake-sidecar.js";

const full = { x: 0, y: 0, w: 1920, h: 1080 };

export const TELEGRAM: FakeWindow = { hwnd: 22, pid: 7, process: "Telegram", title: "Избранное — Telegram", ...full };
export const NOTEPAD: FakeWindow = { hwnd: 11, pid: 9, process: "notepad", title: "Безымянный — Блокнот", ...full };
export const CHROME: FakeWindow = { hwnd: 33, pid: 30, process: "chrome", title: "Входящие — Gmail — Google Chrome", ...full };
export const OUTLOOK: FakeWindow = { hwnd: 44, pid: 40, process: "OUTLOOK", title: "Входящие — Outlook", ...full };
/** Окно самого Джарвиса (pid клиента) — модалка «Подтвердить» §14 живёт здесь. */
export const OWN: FakeWindow = { hwnd: 99, pid: process.pid, process: "Jarvis", title: "Джарвис", x: 0, y: 0, w: 400, h: 300 };

/** Окно спереди (foreground) — первым в z-порядке. */
export const front = (w: FakeWindow, ...behind: FakeWindow[]): FakeWindow[] => [{ ...w, foreground: true }, ...behind.map((b) => ({ ...b, foreground: false }))];

export const el = (handle: number, name: string, role = "button", box: Partial<FakeElement> = {}): FakeElement => ({ handle, role, name, x: 500, y: 900, w: 90, h: 32, ...box });

/** Одобрение сервера: гранты и срок (сейчас + ttl). */
export const approval = (grants: CommitGrant[], ttlMs = 60_000): CommitApproval => ({ grants, expiresAt: Date.now() + ttlMs });
