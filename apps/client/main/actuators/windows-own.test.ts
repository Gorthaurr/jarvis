/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ — контроль-8 (window-list-overlay): окна СОБСТВЕННОГО процесса не выдаются за состояние системы
 * владельца. В фазе рисования оверлей выделения (по окну на монитор, always-on-top, сфокусировано) попадал в
 * `window.list` и получал foreground:true — на «какое окно активно» модель докладывала окно Джарвиса, а решив, что
 * цель потеряла фокус, звала window_focus и тут же получала отказ вуали (замкнутый круг).
 * Реверт-проверка: снять фильтр по pid → оба кейса падают.
 */
import { describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => ({ windows: [] as Array<Record<string, unknown>> }));
vi.mock("./sidecar-client.js", () => ({ sidecar: () => ({ ready: true, request: async () => ({ windows: st.windows }) }) }));
vi.mock("../monitors.js", () => ({ monitors: { hasMultiple: false, displayForRect: () => undefined } }));

import { listWindows } from "./windows.js";
import { selectionStore } from "../selection/store.js";

const win = (over: Record<string, unknown>) => ({ hwnd: 1, pid: 999, process: "Discord.exe", title: "Discord", foreground: false, minimized: false, x: 0, y: 0, w: 100, h: 100, ...over });

describe("window.list не выдаёт СВОИ окна за окна владельца", () => {
  it("окно оверлея выделения (наш процесс, foreground) отфильтровано; чужие окна целы", async () => {
    selectionStore.registerOverlayWindow(7); // контроль-9: режем ИМЕННО окна вуали, а не всё окно-хозяйство процесса
    st.windows = [
      win({ hwnd: 7, pid: process.pid, process: "electron.exe", title: "Jarvis — выделение области", foreground: true }),
      win({ hwnd: 8, pid: 4242, process: "Discord.exe", title: "Discord" }),
    ];
    const out = await listWindows();
    expect(out.map((w) => w.hwnd)).toEqual([8]);
    expect(out.some((w) => w.foreground)).toBe(false); // переднее окно оверлея не выдаётся за активное окно владельца
    selectionStore.unregisterOverlayWindow(7);
  });

  it("без наших окон список не меняется (фильтр не глотает чужое)", async () => {
    st.windows = [win({ hwnd: 8, pid: 4242 }), win({ hwnd: 9, pid: 4243, title: "Chrome", process: "chrome.exe" })];
    expect((await listWindows()).map((w) => w.hwnd)).toEqual([8, 9]);
  });
});

// Контроль-9 (window-list-drops-own-window-always): фильтр был по PID и БЕЗУСЛОВНЫМ — вместе с окнами вуали
// исчезало ГЛАВНОЕ окно Джарвиса (тот же процесс), и «перенеси окно Джарвиса на второй монитор» отвечало
// «окна нет среди открытых», а модель докладывала владельцу выдуманную причину.
describe("window.list: своё ГЛАВНОЕ окно остаётся видимым", () => {
  it("окно Джарвиса (наш pid, НЕ зарегистрировано вуалью) остаётся; зарегистрированное окно вуали — нет", async () => {
    selectionStore.setDrawing(false);
    selectionStore.registerOverlayWindow(77);
    st.windows = [
      win({ hwnd: 77, pid: process.pid, process: "electron.exe", title: "Jarvis — выделение области", foreground: true }),
      win({ hwnd: 78, pid: process.pid, process: "electron.exe", title: "Jarvis" }),
      win({ hwnd: 8, pid: 4242 }),
    ];
    const out = await listWindows();
    expect(out.map((w) => w.hwnd)).toEqual([78, 8]); // до фикса: [8] — окно Джарвиса было недостижимо для window_arrange
    selectionStore.unregisterOverlayWindow(77);
  });

  it("контроль-10: в фазе рисования ГЛАВНОЕ окно Джарвиса остаётся видимым — режем только зарегистрированную вуаль", async () => {
    // Фолбэк «в рисовании режем ВСЕ свои окна» делал `wait_for{kind:\"window\"}` по окну Джарвиса слепым и отвечал
    // ДОСТОВЕРНЫМ «окна нет», а `window_arrange{minimize}` (единственная незагейченная операция) — «не найдено».
    selectionStore.setDrawing(true);
    selectionStore.registerOverlayWindow(79);
    st.windows = [
      win({ hwnd: 79, pid: process.pid, process: "electron.exe", title: "Jarvis — выделение области", foreground: true }),
      win({ hwnd: 80, pid: process.pid, process: "electron.exe", title: "Jarvis" }),
      win({ hwnd: 8, pid: 4242 }),
    ];
    expect((await listWindows()).map((w) => w.hwnd)).toEqual([80, 8]);
    selectionStore.unregisterOverlayWindow(79);
    selectionStore.setDrawing(false);
  });
});
