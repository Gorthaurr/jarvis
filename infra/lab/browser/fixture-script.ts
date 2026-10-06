/**
 * Общий скрипт страниц-фикстур (`/__lab.js`): `labEvent(kind, detail)` шлёт событие в журнал сервера фикстур. keepalive —
 * чтобы событие дошло, даже если клик увёл страницу; ошибки глотаем, страница стенда не должна падать из-за журнала.
 */
export const LAB_SCRIPT = `window.labEvent = function (kind, detail) {
  try {
    fetch('/__event', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: kind, page: location.pathname, detail: detail || {} }) });
  } catch (e) { /* журнал недоступен — страница живёт дальше */ }
};
`;
