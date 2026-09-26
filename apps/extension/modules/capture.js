/**
 * tab.capture (контракт W1 §1): снимок ВИДИМОЙ области вкладки или зум (rect в CSS px / ref элемента).
 * Снимается только АКТИВНАЯ вкладка несвёрнутого окна (captureVisibleTab) — фокус у владельца не крадём: не активна →
 * tab_not_visible; активность сверяется ДО и ПОСЛЕ снимка (переключил вкладку во время снимка — кадр чужой, не отдаём).
 * Провал не бросаем — {ok:false, code, error} данными: tab_not_visible | not_found | ref_stale | tab_closed |
 * capture_failed (ref во встроенном фрейме, область вне вьюпорта, отказ Chrome). Права: <all_urls> (уже в manifest).
 */
import { parseRef } from "./utils.js";
import { readyTargetTab } from "./tab-find.js";
import { pngSize, planCapture } from "./capture-math.js";
import { renderCapture } from "./capture-render.js";

const captureFail = (code, error) => ({ ok: false, code, error });

/** targetFn — page-функция изолированного мира (реестр ref): {ok, w, h, dpr, rect?} | {ok:false, code, error}. */
export async function tabCapture(url, tabId, opts, targetFn) {
  const o = opts || {};
  let tab;
  try {
    ({ tab } = await readyTargetTab(url, tabId));
  } catch (e) {
    return captureFail((e && e.code) || "not_found", String((e && e.message) || e));
  }
  try {
    if (!tab.active) return captureFail("tab_not_visible", "вкладка не на переднем плане — снимок сделал бы кадр чужой вкладки; фокус у владельца не забираю (читай текст: browser_read)");
    try {
      const w = await chrome.windows.get(tab.windowId);
      if (w && w.state === "minimized") return captureFail("tab_not_visible", "окно Chrome свёрнуто — снимать нечего");
    } catch { /* окно не узнали — снимок покажет */ }
    let localRef = null;
    if (o.ref != null && String(o.ref).trim()) {
      const pr = parseRef(o.ref);
      if (!pr) return captureFail("ref_stale", "некорректный ref — сделай browser_inspect заново");
      if (pr.frame) return captureFail("capture_failed", "элемент во встроенном фрейме — его прямоугольник отсюда не вырезать; сними вкладку без ref");
      localRef = pr.localRef;
    }
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: targetFn, args: [localRef] });
    const vp = res && res.result;
    if (!vp || !vp.ok) return captureFail((vp && vp.code) || "capture_failed", (vp && vp.error) || "страница не ответила");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const after = await chrome.tabs.get(tab.id);
    if (!after || !after.active || after.windowId !== tab.windowId) return captureFail("tab_not_visible", "вкладку сменили во время снимка — кадр не её");
    const size = pngSize(dataUrl);
    if (!size) return captureFail("capture_failed", "Chrome вернул не PNG");
    const plan = planCapture({ imgW: size.width, imgH: size.height, viewW: vp.w, viewH: vp.h, rect: localRef ? vp.rect : o.rect, scale: o.scale });
    if (plan.error) return captureFail("capture_failed", plan.error);
    const out = plan.identity ? dataUrl : await renderCapture(dataUrl, plan);
    return { ok: true, dataUrl: out, width: plan.outW, height: plan.outH, dpr: plan.dpr, cssRect: plan.cssRect };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return captureFail(/no tab/i.test(msg) ? "tab_closed" : "capture_failed", msg);
  }
}
