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

    /// <summary>Зарегистрировать уже известный элемент и вернуть GroundResult.</summary>
    private GroundResult RegisterElement(AutomationElement el)
    {
        int handle = System.Threading.Interlocked.Increment(ref _nextHandle);
        _registry[handle] = el;

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

        switch (pattern.ToLowerInvariant())
        {
            case "invoke":
                if (el.GetCurrentPattern(InvokePattern.Pattern) is InvokePattern inv)
                    inv.Invoke();
                else
                    throw new InvalidOperationException("Элемент не поддерживает InvokePattern");
                break;

            case "setvalue":
                if (el.GetCurrentPattern(ValuePattern.Pattern) is ValuePattern vp)
                    vp.SetValue(value ?? "");
                else
                    throw new InvalidOperationException("Элемент не поддерживает ValuePattern");
                break;

            case "select":
                if (el.GetCurrentPattern(SelectionItemPattern.Pattern) is SelectionItemPattern sip)
                    sip.Select();
                else
                    throw new InvalidOperationException("Элемент не поддерживает SelectionItemPattern");
                break;

            case "toggle":
                if (el.GetCurrentPattern(TogglePattern.Pattern) is TogglePattern tp)
                    tp.Toggle();
                else
                    throw new InvalidOperationException("Элемент не поддерживает TogglePattern");
                break;

            case "expand":
                if (el.GetCurrentPattern(ExpandCollapsePattern.Pattern) is ExpandCollapsePattern ecp)
                    ecp.Expand();
                else
                    throw new InvalidOperationException("Элемент не поддерживает ExpandCollapsePattern");
                break;

            case "scroll":
                if (el.GetCurrentPattern(ScrollPattern.Pattern) is ScrollPattern sp)
                    sp.Scroll(ScrollAmount.SmallIncrement, ScrollAmount.SmallIncrement);
                else
                    throw new InvalidOperationException("Элемент не поддерживает ScrollPattern");
                break;

            default:
                throw new ArgumentException($"Неизвестный паттерн: {pattern}");
        }
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

        if (el.GetCurrentPattern(TextPattern.Pattern) is not TextPattern textPattern)
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

        string name = el.Current.Name ?? "";
        string value = "";

        if (el.GetCurrentPattern(ValuePattern.Pattern) is ValuePattern vp)
            value = vp.Current.Value ?? "";

        if (!string.IsNullOrWhiteSpace(name) || !string.IsNullOrWhiteSpace(value))
        {
            string role = el.Current.ControlType.ProgrammaticName;
            sb.Append(role).Append(": ").Append(name);
            if (!string.IsNullOrWhiteSpace(value))
                sb.Append(" [").Append(value).Append(']');
            sb.AppendLine();
        }

        // Рекурсивный обход потомков
        AutomationElementCollection children = el.FindAll(TreeScope.Children, Condition.TrueCondition);
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
