/**
 * Конверт ответа service worker серверу (контракт W1 §7): {id, ok:true, data} | {id, ok:false, error, code?, label?}.
 * Код отказа доходит дважды: первым словом текста ошибки (так его читает сервер до W1) и полем `code` (мост кладёт его
 * в e.code); `label` — подпись элемента-коммита для вопроса владельцу (§14). Без chrome-API — тестируется напрямую.
 */
export async function replyFor(msg, handler) {
  try {
    const data = await handler(msg);
    return { id: msg.id, ok: true, data };
  } catch (e) {
    const out = { id: msg.id, ok: false, error: String((e && e.message) || e) };
    if (e && typeof e.code === "string" && e.code) out.code = e.code;
    if (e && typeof e.label === "string" && e.label) out.label = e.label;
    return out;
  }
}
