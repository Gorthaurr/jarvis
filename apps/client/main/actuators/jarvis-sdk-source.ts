/**
 * Исходник python-модуля `jarvis` (SDK среды исполнения «1 раунд = вся задача»).
 *
 * code-runner пишет этот текст в `jarvis.py` в рабочий каталог python-скрипта (см. code-runner.ts),
 * и модель `import jarvis`-ит его, чтобы драйвить актуаторы клиента через loopback-мост (act-bridge.ts)
 * ОДНИМ скриптом, без похода в LLM между шагами. API-справку для модели держим в persona/code_run-описании.
 *
 * ЭРГОНОМИКА (живой смоук): модель зовёт API ПО ИНТУИЦИИ — таймауты в СЕКУНДАХ (`timeout=5`), знакомые
 * имена (`type`/`press`/`open`). Поэтому SDK ПРОЩАЮЩИЙ: секунды→мс, алиасы, гибкие kwargs — чтобы
 * естественный вызов модели просто работал, а не падал на несовпадении сигнатуры.
 *
 * Чистый stdlib (urllib) — без внешних зависимостей: runnerEnv может не иметь pip-пакетов.
 */
export const JARVIS_SDK_PY = String.raw`# jarvis SDK — драйвим актуаторы клиента из одного code_run-скрипта.
import os, json, time, urllib.request, urllib.error

_URL = os.environ.get("JARVIS_ACT_URL")
_TOKEN = os.environ.get("JARVIS_ACT_TOKEN", "")


class JarvisError(Exception):
    pass


def _call(kind, **fields):
    if not _URL:
        raise JarvisError("jarvis SDK недоступен (нет JARVIS_ACT_URL) — вызывать только из code_run")
    body = json.dumps({"kind": kind, **fields}).encode("utf-8")
    req = urllib.request.Request(
        _URL, data=body, method="POST",
        headers={"Content-Type": "application/json", "X-Jarvis-Token": _TOKEN},
    )
    try:
        with urllib.request.urlopen(req, timeout=190) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # Мост ОТВЕТИЛ отказом (403 kind вне allowlist / 413 большое тело / 400 / 404) — честно отдаём
        # причину из тела, НЕ выдаём за «не ответил» (иначе модель уйдёт в бесполезный ретрай).
        msg = None
        try:
            data = json.loads(e.read().decode("utf-8"))
            msg = (data.get("error") or {}).get("message")
        except Exception:
            msg = None
        raise JarvisError("мост отклонил (%s): %s" % (e.code, msg or e.reason))
    except Exception as e:
        raise JarvisError("мост актуаторов не ответил: %s" % e)


def _ok(kind, **fields):
    res = _call(kind, **fields)
    if not res.get("ok"):
        err = res.get("error") or {}
        raise JarvisError("%s: %s" % (kind, err.get("message", "провал")))
    return res.get("data")


def _ms(timeout=None, timeout_ms=None, default=8000):
    "Секунды (timeout) ИЛИ миллисекунды (timeout_ms) → мс. Модель обычно даёт секунды."
    if timeout_ms is not None:
        return int(timeout_ms)
    if timeout is not None:
        return int(float(timeout) * 1000)
    return default


# ── приложения / окна ─────────────────────────────────────────────
def launch(app):
    "Запустить приложение/URL ('notepad', 'блокнот', 'https://...'). Кидает JarvisError при провале."
    return _ok("app.launch", app=app)


def focus(query=None, hwnd=None):
    "Вывести окно на передний план по подстроке заголовка/имени процесса или hwnd."
    f = {}
    if query is not None:
        f["query"] = query
    if hwnd is not None:
        f["hwnd"] = hwnd
    return _ok("window.focus", **f)


def close(app, force=False):
    "Закрыть приложение по имени процесса (сам Джарвис/критические не тронет)."
    return _ok("app.close", app=app, force=force)


def windows():
    "Список окон верхнего уровня: [{hwnd, title, process, ...}]."
    return (_ok("window.list") or {}).get("windows", [])


# ── ввод ──────────────────────────────────────────────────────────
def key(combo, mode=None, scancode=False):
    "Нажать клавишу/сочетание ('r', 'ctrl+s', 'enter'). mode='down'/'up' — удержание (игры). scancode=True для игр."
    f = {"combo": combo, "scancode": bool(scancode)}
    if mode:
        f["mode"] = mode
    return _ok("input.key", **f)


def write(text):
    "Напечатать текст в активное (сфокусированное) поле."
    return _ok("input.type", text=text)


def click(x, y, button=None, count=None, space="screen"):
    "Клик по координатам. По умолчанию space='screen' — АБСОЛЮТНЫЕ экранные DIP: ровно в этой системе координаты возвращают ocr() и find() (единая система координат SDK). Передай space=None ТОЛЬКО если координаты из последнего screen_capture (vision). button='left'/'right'/'middle', count=2 — двойной."
    tgt = {"by": "coords", "x": int(round(x)), "y": int(round(y))}
    if space:
        tgt["space"] = space
    f = {"target": tgt}
    if button:
        f["button"] = button
    if count:
        f["count"] = count
    return _ok("input.click", **f)


def invoke(handle, pattern="invoke", value=None):
    "Инвокнуть UIA-элемент по handle (из find()/snapshot()) — БЕЗ курсора, надёжнее клика."
    f = {"target": {"by": "handle", "handle": handle}, "pattern": pattern}
    if value is not None:
        f["value"] = value
    return _ok("ui.invoke", **f)


# Алиасы под интуицию модели.
type = write
press = key
open = launch


# ── восприятие ────────────────────────────────────────────────────
def snapshot(pid=None, max_items=200):
    "Set-of-marks активного окна: {items:[{handle, role, name, value, automationId}]}. Действие по элементу — через invoke(handle) или find('имя').click() (надёжно, без курсора). Пусто у UIA-слепых окон (игры) → используй ocr()."
    f = {"maxItems": max_items}
    if pid is not None:
        f["pid"] = pid
    data = _ok("ui.snapshot", **f) or {}
    # bbox элементов приходят в ФИЗИЧЕСКИХ пикселях UIA, НЕ в screen-DIP системе SDK — прямой click по ним
    # (дефолт space="screen") промахнулся бы на масштабированном дисплее и вернул ok = ЛОЖНЫЙ УСПЕХ.
    # Действие по элементу идёт через handle→invoke, поэтому координаты не отдаём (как rect-ветка ocr()).
    for it in data.get("items", []):
        for k in ("x", "y", "w", "h", "bbox"):
            it.pop(k, None)
    return data


def ocr(monitor=None, rect=None, lang=None):
    "Локальный OCR экрана: {text, lines:[...], space}. Для окон без UIA-дерева (игры/canvas). Для ПОЛНОГО кадра (без rect) строки несут x,y,w,h в АБСОЛЮТНЫХ экранных DIP (space=='screen') — можно кликать click(x,y) напрямую. Для rect координаты НЕ отдаются (только text): они неклик­абельны в единой системе — кликать по региону через find() или полноэкранный ocr()."
    f = {}
    if monitor is not None:
        f["monitor"] = monitor
    if rect is not None:
        f["rect"] = rect
    if lang is not None:
        f["lang"] = lang
    data = _ok("screen.ocr", **f) or {}
    # Единая система координат SDK — АБСОЛЮТНЫЕ экранные DIP. Полный кадр даёт mapping → конвертируем
    # thumbnail-px строк в screen-DIP (boundsX + x/scale), чтобы click(x,y) по ним попадал.
    m = data.get("mapping")
    if m and m.get("scale"):
        s = m["scale"]
        bx = m.get("boundsX", 0)
        by = m.get("boundsY", 0)
        for ln in data.get("lines", []):
            if ln.get("x") is not None:
                ln["x"] = bx + ln["x"] / s
            if ln.get("y") is not None:
                ln["y"] = by + ln["y"] / s
            if ln.get("w") is not None:
                ln["w"] = ln["w"] / s
            if ln.get("h") is not None:
                ln["h"] = ln["h"] / s
        data["space"] = "screen"
    else:
        # Нет mapping (rect / space:"screen"-rect): координаты в неоднозначной, НЕ screen-DIP системе.
        # Убираем x/y/w/h (текст оставляем) — иначе click(ln["x"],ln["y"]) с дефолтом space="screen"
        # ушёл бы мимо и вернул ok = ЛОЖНЫЙ УСПЕХ. Теперь попытка взять ln["x"] честно упадёт ошибкой.
        for ln in data.get("lines", []):
            for k in ("x", "y", "w", "h"):
                ln.pop(k, None)
    return data


def read_context(scope="active_window"):
    "Текст активного окна/выделения (дейксис)."
    return _ok("context.read", scope=scope)


# ── ожидание событий (без LLM-раундов) ────────────────────────────
def wait_for(condition, timeout=None, timeout_ms=None, poll_ms=None):
    "Ждать условие (dict {kind:'ui'|'window'|'text'|'sound'|'gsi', ...}). timeout в СЕКУНДАХ. → {met:bool,...}."
    f = {"condition": condition, "timeoutMs": _ms(timeout, timeout_ms)}
    if poll_ms is not None:
        f["pollMs"] = poll_ms
    return _ok("wait.for", **f)


def wait_text(text, timeout=None, timeout_ms=None, gone=False):
    "Ждать появления (gone=True — исчезновения) текста на экране (OCR). timeout в СЕКУНДАХ."
    return wait_for({"kind": "text", "text": text, "gone": gone}, timeout, timeout_ms)


def wait_window(title, timeout=None, timeout_ms=None, gone=False):
    "Ждать появления/исчезновения окна по подстроке заголовка. timeout в СЕКУНДАХ."
    return wait_for({"kind": "window", "titleContains": title, "gone": gone}, timeout, timeout_ms)


def sleep(seconds):
    time.sleep(float(seconds))


# ── высокоуровневый поиск + действие (перцепция + действие в одном) ─
class Element(object):
    def __init__(self, handle=None, x=None, y=None, name=None, space=None):
        self.handle = handle
        self.x = x           # координаты клика (если нет handle); в системе self.space
        self.y = y
        self.name = name
        self.space = space   # None → система последнего снимка (маппинг); "screen" → абсолютные DIP

    def click(self):
        "Кликнуть: по handle через UIA-invoke (НАДЁЖНЫЙ путь, без курсора/координат), иначе по координатам (OCR-фолбэк, уже в screen-DIP)."
        if self.handle is not None:
            return invoke(self.handle, "invoke")
        if self.x is not None and self.y is not None:
            return click(self.x, self.y, space=self.space)
        raise JarvisError("элемент не найден — кликать нечем")

    def write(self, text):
        "Сфокусировать элемент (клик) и напечатать в него текст."
        self.click()
        return _ok("input.type", text=text)

    type = write

    def __bool__(self):
        return self.handle is not None or self.x is not None
    __nonzero__ = __bool__


def _center(o):
    "Центр bbox из ПЛОСКИХ полей x,y,w,h (реальный формат ui.snapshot/screen.ocr). None если координат нет."
    x, y, w, h = o.get("x"), o.get("y"), o.get("w"), o.get("h")
    if x is None or y is None or w is None or h is None:
        return None
    return (x + w / 2.0, y + h / 2.0)


def find(text):
    "Найти элемент/текст по подстроке. Сначала UIA-снапшот (handle→надёжный invoke, независим от DPI/монитора), затем OCR (для UIA-слепых окон). Falsy Element, если не нашли — проверяй 'if el:'."
    tl = text.lower()
    try:
        snap = snapshot() or {}
        for it in snap.get("items", []):
            nm = ((it.get("name") or "") + " " + (it.get("value") or "")).lower()
            if tl in nm:
                # НАДЁЖНЫЙ путь — invoke по handle (без координат). handle у снапшота есть всегда.
                return Element(handle=it.get("handle"), name=it.get("name"))
    except JarvisError:
        pass
    try:
        o = ocr() or {}
        # ocr() уже вернул координаты в АБСОЛЮТНЫХ screen-DIP (space=='screen') для полного кадра.
        # Если space нет (rect / нет mapping) — координаты неклик­абельны → честно не матчим под клик.
        dip = o.get("space") == "screen"
        for ln in o.get("lines", []):
            if tl in (ln.get("text") or "").lower():
                c = _center(ln)
                if c is None:
                    continue  # нет координат — не матчим (иначе клик в 0,0)
                if not dip:
                    continue  # координаты не в screen-DIP → клик ушёл бы мимо = ложный успех
                return Element(x=c[0], y=c[1], name=ln.get("text"), space="screen")
    except JarvisError:
        pass
    return Element()
`;
