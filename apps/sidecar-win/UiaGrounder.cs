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
    // Граница реестра дескрипторов: AutomationElement держит нативные/COM-ресурсы,
    // без вытеснения долгая сессия копит тысячи ссылок (утечка). Храним последние N.
    private const int MaxRegistry = 512;

    // -----------------------------------------------------------------------
    // Грундинг
    // -----------------------------------------------------------------------

    /// <summary>
    /// Найти элемент по роли UIA и (опционально) имени.
    /// <paramref name="scope"/>: null / "" = рабочий стол; иначе — pid процесса-владельца окна.
    /// Возвращает null если элемент не найден.
    /// </summary>
    public GroundResult? Ground(string role, string? name, string? scope)
    {
        AutomationElement root = ResolveRoot(scope);

        ControlType? ct = RoleToControlType(role);
        if (ct is null)
            throw new ArgumentException($"Неизвестная роль: {role}");

        // Строим условие поиска.
        Condition cond = string.IsNullOrEmpty(name)
            ? new PropertyCondition(AutomationElement.ControlTypeProperty, ct)
            : new AndCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ct),
                new PropertyCondition(AutomationElement.NameProperty, name, PropertyConditionFlags.IgnoreCase));

        AutomationElement? found = root.FindFirst(TreeScope.Descendants, cond);
        if (found is null)
            return null;

        return RegisterElement(found);
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

    /// <summary>Зарегистрировать уже известный элемент и вернуть GroundResult.</summary>
    private GroundResult RegisterElement(AutomationElement el)
    {
        int handle = System.Threading.Interlocked.Increment(ref _nextHandle);
        _registry[handle] = el;
        TrimRegistry();

        System.Windows.Rect bbox = el.Current.BoundingRectangle;
        return new GroundResult(
            Handle: handle,
            X: bbox.X,
            Y: bbox.Y,
            W: bbox.Width,
            H: bbox.Height,
            Name: el.Current.Name ?? "",
            Role: el.Current.ControlType.ProgrammaticName
        );
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
            string value = "";

            // TryGetCurrentPattern — НЕ GetCurrentPattern (тот бросает на неподдержке).
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out object? vpObj) && vpObj is ValuePattern vp)
                value = vp.Current.Value ?? "";

            if (!string.IsNullOrWhiteSpace(name) || !string.IsNullOrWhiteSpace(value))
            {
                string role = el.Current.ControlType.ProgrammaticName;
                sb.Append(role).Append(": ").Append(name);
                if (!string.IsNullOrWhiteSpace(value))
                    sb.Append(" [").Append(value).Append(']');
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
