// §6, §18, §19 — Резолв UI-контролов через System.Windows.Automation (UIAutomation).
// UIAutomation работает в том же процессе, что и SendInput (InputSynthesizer),
// устраняя IPC-гонку «нашёл элемент → успел кликнуть» (§6).

using System.Collections.Concurrent;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace SidecarWin;

/// <summary>
/// Грундинг UI-элементов: поиск по роли (ControlType) и имени, кэш дескрипторов,
/// вызов UIA-паттернов. Singleton — создаётся один раз в Program.cs.
/// </summary>
public sealed class UiaGrounder : IDisposable
{
    // Внутренний реестр: числовой handle → AutomationElement.
    // AutomationElement не является COM-объектом с владением, поэтому просто храним ссылку.
    private readonly ConcurrentDictionary<int, AutomationElement> _registry = new();
    private int _nextHandle = 1;

    // Максимальная глубина поиска в дереве (§6 — не сканировать весь рабочий стол без нужды).
    private const int MaxSearchDepth = 8;
    // Лимит символов при выгрузке текста окна (§19).
    private const int DefaultMaxChars = 8_000;
    /// <summary>Кап чтения содержимого поля ввода через TextPattern (выжимка/снапшот — не полный дамп документа).</summary>
    private const int TextInputValueCap = 400;
    // Граница реестра дескрипторов: AutomationElement держит нативные/COM-ресурсы,
    // без вытеснения долгая сессия копит тысячи ссылок (утечка). Храним последние N.
    // §Волна2: 512→2048 — снапшоты регистрируют до 60 хендлов за вызов; при бурсте снапшотов
    // старый кап вытеснял handle, который модель ещё держала в контексте (ревью).
    private const int MaxRegistry = 2048;

    // -----------------------------------------------------------------------
    // Грундинг
    // -----------------------------------------------------------------------

    /// <summary>
    /// Найти элемент по роли UIA и (опционально) имени/AutomationId.
    /// <paramref name="scope"/> (§Волна2 2.4): null/"" = АКТИВНОЕ окно, при промахе — фолбэк на весь
    /// рабочий стол (exact-поиск по всему столу медленный и ловит чужие окна); "desktop" = сразу весь
    /// стол; pid = окно процесса. <paramref name="nameMode"/>="substring" — матч имени по вхождению.
    /// Возвращает null если элемент не найден.
    /// </summary>
    public GroundResult? Ground(string role, string? name, string? scope, string? nameMode = null, string? automationId = null)
    {
        ControlType? ct = RoleToControlType(role);
        if (ct is null)
            throw new ArgumentException($"Неизвестная роль: {role}");

        bool substring = nameMode == "substring" && !string.IsNullOrEmpty(name);
        foreach ((AutomationElement root, bool isDesktop) in CandidateRoots(scope))
        {
            AutomationElement? found = FindIn(root, ct, name, substring, automationId, isDesktop);
            if (found is not null) return RegisterElement(found);
        }
        return null;
    }

    /// <summary>Корни поиска по scope: pid → окно процесса; null/"" → активное окно, затем весь стол.
    /// Флаг isDesktop передаётся ЯВНО: AutomationElement.RootElement — НОВЫЙ инстанс на каждый доступ,
    /// ReferenceEquals с ним всегда false (живой прогон: substring падал в полный UIA-обход стола).</summary>
    private static IEnumerable<(AutomationElement root, bool isDesktop)> CandidateRoots(string? scope)
    {
        if (!string.IsNullOrEmpty(scope) && scope != "desktop" && int.TryParse(scope, out int pid))
        {
            Condition pidCond = new PropertyCondition(AutomationElement.ProcessIdProperty, pid);
            AutomationElement? win = null;
            try { win = AutomationElement.RootElement.FindFirst(TreeScope.Children, pidCond); } catch { /* окна нет */ }
            // Ревью Волны 2: явный pid БЕЗ окна → пусто → честное «не найдено».
            // Молчаливое расширение на весь стол грундило бы ЧУЖОЕ приложение.
            if (win is not null) yield return (win, false);
            yield break;
        }
        // Ревью Волны 3 (#6): scope="active" — ТОЛЬКО активное окно, БЕЗ фолбэка на весь стол. Для
        // ПРЕДУСЛОВИЙ шага навыка: элемент обязан быть в текущем активном окне, иначе кнопка с той же
        // ролью/именем в ЛЮБОМ фоновом окне давала бы ложный pass предусловия → слепой клик по
        // изменившемуся экрану. Промах в активном окне = честный «не выполнено» (без обхода стола).
        if (scope == "active")
        {
            AutomationElement? fgOnly = ForegroundWindowElement();
            if (fgOnly is not null) yield return (fgOnly, false);
            yield break;
        }
        if (string.IsNullOrEmpty(scope))
        {
            AutomationElement? fg = ForegroundWindowElement();
            if (fg is not null) yield return (fg, false);
        }
        yield return (AutomationElement.RootElement, true);
    }

    /// <summary>Активное (foreground) окно как AutomationElement; null при сбое (защищённое окно/десктоп).</summary>
    private static AutomationElement? ForegroundWindowElement()
    {
        try
        {
            IntPtr h = WindowManager.Foreground();
            return h == IntPtr.Zero ? null : AutomationElement.FromHandle(h);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Поиск в корне: точное имя — через PropertyCondition; substring — перебор кандидатов роли.</summary>
    private static AutomationElement? FindIn(AutomationElement root, ControlType ct, string? name, bool substring, string? automationId, bool isDesktop)
    {
        var conds = new List<Condition> { new PropertyCondition(AutomationElement.ControlTypeProperty, ct) };
        if (!string.IsNullOrEmpty(automationId))
            conds.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, automationId));
        if (!substring && !string.IsNullOrEmpty(name))
            conds.Add(new PropertyCondition(AutomationElement.NameProperty, name, PropertyConditionFlags.IgnoreCase));
        Condition cond = conds.Count == 1 ? conds[0] : new AndCondition(conds.ToArray());

        try
        {
            // Поиск ОКНА по имени на корне РАБОЧЕГО СТОЛА (exact И substring): UIA-обход стола
            // опрашивает провайдер КАЖДОГО окна и блокируется на зависшем — без таймаута (живой
            // смоук: 40с+ и на промахе exact). Окна ищем БЕЗ UIA — EnumWindows (миллисекунды) →
            // FromHandle только по попаданию.
            if (isDesktop && ct == ControlType.Window && !string.IsNullOrEmpty(name))
            {
                WindowInfo? hit = WindowManager.List().Windows.FirstOrDefault(w =>
                    substring
                        ? w.Title.Contains(name, StringComparison.OrdinalIgnoreCase)
                        : string.Equals(w.Title, name, StringComparison.OrdinalIgnoreCase));
                if (hit is null) return null;
                try { return AutomationElement.FromHandle(new IntPtr(hit.Hwnd)); }
                catch { return null; }
            }
            if (!substring) return root.FindFirst(TreeScope.Descendants, cond);
            // Substring НЕ-оконной роли по всему столу не поддерживаем (честный промах; активное
            // окно уже пробовалось предыдущим кандидатом CandidateRoots).
            if (isDesktop) return null;
            // Substring-перебор ВНУТРИ окна (дерево обозримо): видимый кандидат приоритетнее
            // (ревью: offscreen-дубль перехватывал матч).
            AutomationElementCollection all = root.FindAll(TreeScope.Descendants, cond);
            AutomationElement? offscreenHit = null;
            foreach (AutomationElement el in all)
            {
                try
                {
                    if (!(el.Current.Name ?? "").Contains(name!, StringComparison.OrdinalIgnoreCase)) continue;
                    if (!el.Current.IsOffscreen) return el;
                    offscreenHit ??= el;
                }
                catch { /* элемент исчез между FindAll и чтением — пропускаем */ }
            }
            return offscreenHit;
        }
        catch
        {
            return null; // сбой поиска в этом корне → пробуем следующий (фолбэк на весь стол)
        }
    }

    /// <summary>
    /// §бесшумный-ввод: элемент под ФИЗИЧЕСКОЙ точкой (из screen_capture) → ближайший actionable-предок → handle.
    /// Последующий ui.invoke по этому handle кликает БЕЗ движения курсора. null — под точкой нет UIA-элемента
    /// (canvas/игра) → вызывающий деградирует на оконное сообщение / физ.клик. Для бесшумного клика «по пикселям».
    /// </summary>
    public GroundResult? GroundAtPoint(double physX, double physY)
    {
        AutomationElement? el;
        try { el = AutomationElement.FromPoint(new System.Windows.Point(physX, physY)); }
        catch { return null; }
        if (el is null) return null;
        el = ClimbToActionable(el) ?? el; // предок с Invoke/Toggle/SelectionItem — цель клика (сам пиксель мог попасть в текст/иконку внутри кнопки)
        return RegisterElement(el);
    }

    /// <summary>Подняться по ControlView до предка с Invoke/Toggle/SelectionItem (или до окна/лимита глубины).</summary>
    private static AutomationElement? ClimbToActionable(AutomationElement el)
    {
        TreeWalker walker = TreeWalker.ControlViewWalker;
        AutomationElement? cur = el;
        for (int depth = 0; depth < MaxSearchDepth && cur is not null; depth++)
        {
            if (IsActionable(cur)) return cur;
            if (cur.Current.ControlType == ControlType.Window) break; // выше окна не лезем
            cur = walker.GetParent(cur);
        }
        return null;
    }

    /// <summary>Есть ли у элемента паттерн, которым его можно «нажать» без курсора.</summary>
    private static bool IsActionable(AutomationElement el)
    {
        return el.TryGetCurrentPattern(InvokePattern.Pattern, out _)
            || el.TryGetCurrentPattern(TogglePattern.Pattern, out _)
            || el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out _);
    }

    /// <summary>Зарегистрировать элемент в реестре дескрипторов (handle для последующего invoke/click).</summary>
    private int RegisterHandle(AutomationElement el)
    {
        int handle = System.Threading.Interlocked.Increment(ref _nextHandle);
        _registry[handle] = el;
        TrimRegistry();
        return handle;
    }

    /// <summary>Зарегистрировать уже известный элемент и вернуть GroundResult.
    /// Ревью Волны 2: Rect.Empty/offscreen даёт Infinity — System.Text.Json падает на сериализации
    /// («Infinity» не представим) и вместо результата уходила ошибка. Санируем в 0.</summary>
    private GroundResult RegisterElement(AutomationElement el)
    {
        int handle = RegisterHandle(el);
        System.Windows.Rect bbox = el.Current.BoundingRectangle;
        static double San(double v) => double.IsFinite(v) ? v : 0;
        return new GroundResult(
            Handle: handle,
            X: San(bbox.X),
            Y: San(bbox.Y),
            W: San(bbox.Width),
            H: San(bbox.Height),
            Name: el.Current.Name ?? "",
            Role: el.Current.ControlType.ProgrammaticName
        );
    }

    // -----------------------------------------------------------------------
    // §Волна2 (2.4) — Снапшот интерактивных элементов окна (set-of-marks)
    // -----------------------------------------------------------------------

    /// <summary>ControlType, интересные для снапшота (интерактив), даже без Invoke/Toggle-паттерна.</summary>
    private static readonly ControlType[] InteractiveTypes =
    [
        ControlType.Button, ControlType.Edit, ControlType.ComboBox, ControlType.CheckBox,
        ControlType.RadioButton, ControlType.ListItem, ControlType.MenuItem, ControlType.TabItem,
        ControlType.Hyperlink, ControlType.Slider, ControlType.Spinner, ControlType.SplitButton,
        ControlType.TreeItem,
    ];

    /// <summary>Глубина обхода снапшота — глубже грундинга (вложенные панели современных UI).</summary>
    private const int SnapshotMaxDepth = 14;

    /// <summary>
    /// §Волна2 (2.4): индексированный список ИНТЕРАКТИВНЫХ элементов окна {handle, role, name,
    /// automationId, value, bbox} — «дешёвые глаза» (~сотни токенов текста вместо 2K-скрина).
    /// Каждый элемент регистрируется в реестре — следующий ui.invoke/click бьёт точно по handle.
    /// pid=null → активное (foreground) окно. bbox — ФИЗИЧЕСКИЕ пиксели экрана (как GroundResult).
    /// </summary>
    public SnapshotResult Snapshot(int? pid, int? maxItems)
    {
        AutomationElement root = pid.HasValue
            ? CandidateRoots(pid.Value.ToString()).FirstOrDefault().root
              ?? throw new InvalidOperationException($"У процесса pid={pid} нет окна верхнего уровня — снапшот невозможен")
            : ForegroundWindowElement() ?? AutomationElement.RootElement;

        int cap = Math.Clamp(maxItems ?? 60, 1, 200);
        var items = new List<SnapshotItem>(Math.Min(cap, 64));
        bool truncated = false;
        CollectInteractive(root, items, cap, ref truncated, depth: 0);

        string title = "";
        int rootPid = 0;
        try
        {
            title = root.Current.Name ?? "";
            rootPid = root.Current.ProcessId;
        }
        catch { /* окно исчезло — снапшот всё равно отдаём */ }
        return new SnapshotResult(title, rootPid, items, truncated);
    }

    private void CollectInteractive(AutomationElement el, List<SnapshotItem> items, int cap, ref bool truncated, int depth)
    {
        if (items.Count >= cap) { truncated = true; return; }
        if (depth > SnapshotMaxDepth) return;

        try
        {
            AutomationElement.AutomationElementInformation cur = el.Current;
            // Невидимое (offscreen) пропускаем целиком по узлу, но потомков всё же смотрим на
            // корневом уровне не надо — offscreen-контейнер обычно держит offscreen-потомков.
            if (!cur.IsOffscreen && depth > 0 && (IsActionable(el) || InteractiveTypes.Contains(cur.ControlType)))
            {
                bool isTextInputItem = cur.ControlType == ControlType.Edit || cur.ControlType == ControlType.Document;
                // Безопасность (ревью р2 #10): поле-пароль не читаем (утечка секрета в облачный LLM).
                bool isPasswordItem = false;
                try { isPasswordItem = cur.IsPassword; } catch { }
                string? value = null;
                bool hasTextSrc = false;
                if (!isPasswordItem)
                {
                    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out object? vpObj) && vpObj is ValuePattern vp)
                    {
                        hasTextSrc = true;
                        value = vp.Current.Value;
                    }
                    // Document/многострочный Edit без ValuePattern → TextPattern (иначе содержимое невидимо).
                    if (!hasTextSrc && isTextInputItem
                        && el.TryGetCurrentPattern(TextPattern.Pattern, out object? tpObj) && tpObj is TextPattern tp)
                    {
                        hasTextSrc = true;
                        value = tp.DocumentRange.GetText(TextInputValueCap);
                    }
                }
                // ЧЕСТНОСТЬ (репорт Джарвиса 2026-07-14): у ПУСТОГО поля ввода value = "" ЯВНО
                // (не null/пропуск) — Name такого поля обычно серый placeholder, и без явной пустоты
                // модель принимала подсказку за введённый текст. Поле-пароль → маркер, не содержимое.
                string? valueOut = isPasswordItem && isTextInputItem ? "•••" // [защищено]
                    : (hasTextSrc && string.IsNullOrEmpty(value) && isTextInputItem) ? ""
                    : (string.IsNullOrEmpty(value) ? null : value);
                System.Windows.Rect b = cur.BoundingRectangle;
                items.Add(new SnapshotItem(
                    Handle: RegisterHandle(el),
                    Role: ShortRole(cur.ControlType.ProgrammaticName),
                    Name: cur.Name ?? "",
                    AutomationId: string.IsNullOrEmpty(cur.AutomationId) ? null : cur.AutomationId,
                    Value: valueOut,
                    X: double.IsInfinity(b.X) ? 0 : b.X,
                    Y: double.IsInfinity(b.Y) ? 0 : b.Y,
                    W: double.IsInfinity(b.Width) ? 0 : b.Width,
                    H: double.IsInfinity(b.Height) ? 0 : b.Height));
            }
        }
        catch { /* проблемный узел не рушит снапшот */ }

        AutomationElementCollection children;
        try { children = el.FindAll(TreeScope.Children, Condition.TrueCondition); }
        catch { return; }
        foreach (AutomationElement child in children)
        {
            if (items.Count >= cap) { truncated = true; return; }
            CollectInteractive(child, items, cap, ref truncated, depth + 1);
        }
    }

    /// <summary>"ControlType.Button" → "button" — токен-экономия снапшота.</summary>
    private static string ShortRole(string programmatic)
    {
        int dot = programmatic.LastIndexOf('.');
        string s = dot >= 0 ? programmatic[(dot + 1)..] : programmatic;
        return s.ToLowerInvariant();
    }

    /// <summary>Вытеснить самые старые дескрипторы (handle монотонно растёт) сверх лимита.</summary>
    private void TrimRegistry()
    {
        while (_registry.Count > MaxRegistry)
        {
            int oldest = int.MaxValue;
            foreach (int k in _registry.Keys) if (k < oldest) oldest = k;
            if (oldest == int.MaxValue) break;
            _registry.TryRemove(oldest, out _);
        }
    }

    /// <summary>
    /// Точка клика по дескриптору (§6, fallback синтетического клика по элементу, который
    /// НЕ поддерживает UIA-паттерн — напр. canvas/кастомный контрол). Координаты ФИЗИЧЕСКИЕ.
    /// Предпочитаем ClickablePoint UIA; иначе — центр BoundingRectangle.
    /// </summary>
    public (double x, double y) GetClickPoint(int handle)
    {
        AutomationElement el = GetElement(handle);
        if (el.TryGetClickablePoint(out System.Windows.Point pt) && (pt.X != 0 || pt.Y != 0))
            return (pt.X, pt.Y);
        System.Windows.Rect r = el.Current.BoundingRectangle;
        if (double.IsInfinity(r.Width) || r.IsEmpty)
            throw new InvalidOperationException("Элемент не имеет видимой области для клика");
        return (r.X + r.Width / 2.0, r.Y + r.Height / 2.0);
    }

    // -----------------------------------------------------------------------
    // UIA-паттерны (invoke / setValue / select / toggle / expand / scroll)
    // -----------------------------------------------------------------------

    /// <summary>
    /// Выполнить UIA-паттерн по числовому дескриптору.
    /// <paramref name="pattern"/>: "invoke" | "setValue" | "select" | "toggle" | "expand" | "scroll"
    /// </summary>
    public void Invoke(int handle, string pattern, string? value)
    {
        AutomationElement el = GetElement(handle);

        // ВАЖНО: AutomationElement.GetCurrentPattern БРОСАЕТ при неподдержке паттерна,
        // а не возвращает null. Поэтому везде TryGetCurrentPattern (graceful).
        switch (pattern.ToLowerInvariant())
        {
            case "invoke":
                Require<InvokePattern>(el, InvokePattern.Pattern, "InvokePattern").Invoke();
                break;

            case "setvalue":
                Require<ValuePattern>(el, ValuePattern.Pattern, "ValuePattern").SetValue(value ?? "");
                break;

            case "select":
                Require<SelectionItemPattern>(el, SelectionItemPattern.Pattern, "SelectionItemPattern").Select();
                break;

            case "toggle":
                Require<TogglePattern>(el, TogglePattern.Pattern, "TogglePattern").Toggle();
                break;

            case "expand":
                Require<ExpandCollapsePattern>(el, ExpandCollapsePattern.Pattern, "ExpandCollapsePattern").Expand();
                break;

            case "scroll":
                Require<ScrollPattern>(el, ScrollPattern.Pattern, "ScrollPattern")
                    .Scroll(ScrollAmount.SmallIncrement, ScrollAmount.SmallIncrement);
                break;

            default:
                throw new ArgumentException($"Неизвестный паттерн: {pattern}");
        }
    }

    /// <summary>Получить паттерн или бросить понятную ошибку (без падения на «Unsupported pattern»).</summary>
    private static T Require<T>(AutomationElement el, AutomationPattern pattern, string label) where T : class
    {
        if (el.TryGetCurrentPattern(pattern, out object? obj) && obj is T typed)
            return typed;
        throw new InvalidOperationException($"Элемент не поддерживает {label}");
    }

    // -----------------------------------------------------------------------
    // §19 — Чтение текста через TextPattern
    // -----------------------------------------------------------------------

    /// <summary>
    /// Вернуть выделенный текст элемента (TextPattern.GetSelection).
    /// Если handle равен null, ищем фокусированный элемент.
    /// </summary>
    public SelectionResult GetSelection(int? handle)
    {
        AutomationElement el = handle.HasValue
            ? GetElement(handle.Value)
            : AutomationElement.FocusedElement
              ?? throw new InvalidOperationException("Нет фокусированного элемента");

        if (!el.TryGetCurrentPattern(TextPattern.Pattern, out object? tpObj) || tpObj is not TextPattern textPattern)
            return new SelectionResult("");

        TextPatternRange[] ranges = textPattern.GetSelection();
        string text = ranges.Length > 0 ? string.Join("\n", Array.ConvertAll(ranges, r => r.GetText(-1))) : "";
        return new SelectionResult(text);
    }

    /// <summary>
    /// §19 — Выгрузить текстовую выжимку a11y-дерева видимой области окна.
    /// Обходит потомков и собирает Name + ValuePattern.Value для каждого контрола.
    /// </summary>
    public WindowReadResult ReadWindow(int? pid, int maxChars = DefaultMaxChars)
    {
        AutomationElement root;
        if (pid.HasValue)
        {
            // Найти главное окно процесса
            Condition cond = new PropertyCondition(AutomationElement.ProcessIdProperty, pid.Value);
            AutomationElement? win = AutomationElement.RootElement.FindFirst(TreeScope.Children, cond);
            root = win ?? AutomationElement.RootElement;
        }
        else
        {
            // Используем окно с фокусом
            root = AutomationElement.FocusedElement ?? AutomationElement.RootElement;
        }

        System.Text.StringBuilder sb = new(maxChars + 256);
        bool truncated = false;
        CollectText(root, sb, maxChars, ref truncated, depth: 0);

        return new WindowReadResult(sb.ToString().Trim(), truncated);
    }

    private static void CollectText(
        AutomationElement el,
        System.Text.StringBuilder sb,
        int maxChars,
        ref bool truncated,
        int depth)
    {
        if (sb.Length >= maxChars) { truncated = true; return; }
        if (depth > MaxSearchDepth) return;

        // Доступ к одному узлу может бросить (элемент исчез, COM-таймаут, защищённое окно) —
        // изолируем, чтобы один проблемный узел не рушил всю выжимку (§19).
        try
        {
            string name = el.Current.Name ?? "";
            System.Windows.Automation.ControlType ct = el.Current.ControlType;
            bool isTextInput = ct == ControlType.Edit || ct == ControlType.Document;
            // Безопасность (ревью р2 #10): поле-ПАРОЛЬ (IsPassword) НЕ читаем — некоторые провайдеры UIA
            // отдают реальный текст через ValuePattern/TextPattern; он уходил бы в облачный LLM/контекст.
            // Зеркалит денилист секретов (.env/id_rsa). Помечаем [ЗАЩИЩЕНО], значение не трогаем.
            bool isPassword = false;
            try { isPassword = el.Current.IsPassword; } catch { }
            string value = "";
            bool hasTextSource = false;

            if (!isPassword)
            {
                // TryGetCurrentPattern — НЕ GetCurrentPattern (тот бросает на неподдержке).
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out object? vpObj) && vpObj is ValuePattern vp)
                {
                    hasTextSource = true;
                    value = vp.Current.Value ?? "";
                }
                // Document/многострочный Edit (Блокнот!) часто БЕЗ ValuePattern — только TextPattern.
                // Без фолбэка их содержимое было НЕВИДИМО выжимке (репорт Джарвиса 2026-07-14: «не вижу,
                // что ввёл»), а пустота — недоказуема. Читаем кап (это выжимка, не полный дамп).
                if (!hasTextSource && isTextInput
                    && el.TryGetCurrentPattern(TextPattern.Pattern, out object? tpObj) && tpObj is TextPattern tp)
                {
                    hasTextSource = true;
                    value = tp.DocumentRange.GetText(TextInputValueCap) ?? "";
                }
            }

            if (!string.IsNullOrWhiteSpace(name) || !string.IsNullOrWhiteSpace(value) || (isTextInput && (hasTextSource || isPassword)))
            {
                string role = ct.ProgrammaticName;
                sb.Append(role).Append(": ").Append(name);
                if (isPassword && isTextInput)
                    sb.Append(" [ЗАЩИЩЕНО]"); // поле-пароль — содержимое не читаем (утечка секрета)
                else if (!string.IsNullOrWhiteSpace(value))
                    sb.Append(" [").Append(value).Append(']');
                else if (hasTextSource && isTextInput)
                    // ЧЕСТНОСТЬ (репорт Джарвиса 2026-07-14): у ПУСТОГО поля ввода Name — это, как
                    // правило, серый placeholder («Напишите сообщение»), и без явной пометки модель
                    // читала подсказку как введённый текст. [ПУСТО] = UIA подтвердил пустоту.
                    sb.Append(" [ПУСТО]");
                sb.AppendLine();
            }
        }
        catch { /* пропускаем проблемный узел */ }

        // Рекурсивный обход потомков
        AutomationElementCollection children;
        try { children = el.FindAll(TreeScope.Children, Condition.TrueCondition); }
        catch { return; }
        foreach (AutomationElement child in children)
        {
            if (sb.Length >= maxChars) { truncated = true; return; }
            CollectText(child, sb, maxChars, ref truncated, depth + 1);
        }
    }

    // -----------------------------------------------------------------------
    // Вспомогательные методы
    // -----------------------------------------------------------------------

    private AutomationElement GetElement(int handle)
    {
        if (!_registry.TryGetValue(handle, out AutomationElement? el))
            throw new KeyNotFoundException($"Дескриптор {handle} не зарегистрирован");
        return el;
    }

    private static AutomationElement ResolveRoot(string? scope)
    {
        if (string.IsNullOrEmpty(scope) || scope == "desktop")
            return AutomationElement.RootElement;

        if (int.TryParse(scope, out int pid))
        {
            Condition pidCond = new PropertyCondition(AutomationElement.ProcessIdProperty, pid);
            AutomationElement? win = AutomationElement.RootElement.FindFirst(TreeScope.Children, pidCond);
            return win ?? AutomationElement.RootElement;
        }

        return AutomationElement.RootElement;
    }

    /// <summary>Маппинг строковых ролей (из @jarvis/protocol Target.role) → UIA ControlType.</summary>
    private static ControlType? RoleToControlType(string role) => role.ToLowerInvariant() switch
    {
        "button"        => ControlType.Button,
        "checkbox"      => ControlType.CheckBox,
        "combobox"      => ControlType.ComboBox,
        "edit"          => ControlType.Edit,
        "hyperlink"     => ControlType.Hyperlink,
        "image"         => ControlType.Image,
        "list"          => ControlType.List,
        "listitem"      => ControlType.ListItem,
        "menu"          => ControlType.Menu,
        "menubar"       => ControlType.MenuBar,
        "menuitem"      => ControlType.MenuItem,
        "progressbar"   => ControlType.ProgressBar,
        "radiobutton"   => ControlType.RadioButton,
        "scrollbar"     => ControlType.ScrollBar,
        "slider"        => ControlType.Slider,
        "spinner"       => ControlType.Spinner,
        "statusbar"     => ControlType.StatusBar,
        "tab"           => ControlType.Tab,
        "tabitem"       => ControlType.TabItem,
        "text"          => ControlType.Text,
        "toolbar"       => ControlType.ToolBar,
        "tooltip"       => ControlType.ToolTip,
        "tree"          => ControlType.Tree,
        "treeitem"      => ControlType.TreeItem,
        "custom"        => ControlType.Custom,
        "group"         => ControlType.Group,
        "thumb"         => ControlType.Thumb,
        "datagrid"      => ControlType.DataGrid,
        "dataitem"      => ControlType.DataItem,
        "document"      => ControlType.Document,
        "splitbutton"   => ControlType.SplitButton,
        "window"        => ControlType.Window,
        "pane"          => ControlType.Pane,
        "header"        => ControlType.Header,
        "headeritem"    => ControlType.HeaderItem,
        "table"         => ControlType.Table,
        "titlebar"      => ControlType.TitleBar,
        "separator"     => ControlType.Separator,
        _               => null,
    };

    public void Dispose()
    {
        _registry.Clear();
    }
}
