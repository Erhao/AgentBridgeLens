using System.Runtime.InteropServices;
using System.Text.Json;
using Interop.UIAutomationClient;

namespace AgentBridgeLens.Windows;

internal sealed record NodeRef(IUIAutomationElement Element, int[] RuntimeId, string Name, int ControlType);
internal sealed record Snapshot(WindowRef Window, Dictionary<string, NodeRef> Nodes);

internal sealed class Accessibility : IDisposable
{
    // Constructed and used only on the protocol worker's long-lived MTA thread.
    private readonly IUIAutomation automation = new CUIAutomation();
    private readonly References<Snapshot> snapshots = new(TimeSpan.FromSeconds(60), 8);
    private static readonly Dictionary<int, string> Roles = new()
    {
        [50000] = "button", [50001] = "calendar", [50002] = "checkbox", [50003] = "combobox",
        [50004] = "edit", [50005] = "hyperlink", [50006] = "image", [50007] = "listitem",
        [50008] = "list", [50009] = "menu", [50010] = "menubar", [50011] = "menuitem",
        [50012] = "progressbar", [50013] = "radiobutton", [50014] = "scrollbar", [50015] = "slider",
        [50016] = "spinner", [50017] = "statusbar", [50018] = "tab", [50019] = "tabitem",
        [50020] = "text", [50021] = "toolbar", [50022] = "tooltip", [50023] = "tree",
        [50024] = "treeitem", [50025] = "custom", [50026] = "group", [50027] = "thumb",
        [50028] = "datagrid", [50029] = "dataitem", [50030] = "document", [50031] = "splitbutton",
        [50032] = "window", [50033] = "pane", [50034] = "header", [50035] = "headeritem",
        [50036] = "table", [50037] = "titlebar", [50038] = "separator"
    };
    private static readonly (int Id, string Name)[] Patterns =
        [(10000, "invoke"), (10002, "set_text"), (10015, "toggle"), (10005, "expand_collapse"), (10010, "select"), (10014, "text")];

    public Dictionary<string, object?> Observe(WindowRef window, string windowId, JsonElement parameters, WorkContext context)
    {
        window.Check();
        int maxDepth = parameters.Integer("maxDepth", 6, 0, 16), maxNodes = parameters.Integer("maxNodes", 300, 1, 1000);
        var cache = automation.CreateCacheRequest();
        cache.TreeScope = TreeScope.TreeScope_Element;
        foreach (var id in new[] { 30000, 30001, 30003, 30005, 30008, 30009, 30010, 30011, 30019, 30022 }) cache.AddProperty(id);
        foreach (var pattern in Patterns) cache.AddPattern(pattern.Id);
        var root = automation.ElementFromHandleBuildCache(window.Handle, cache);
        var walker = automation.ControlViewWalker;
        var references = new Dictionary<string, NodeRef>();
        var nodes = new List<Dictionary<string, object?>>();
        bool truncated = false;
        int skipped = 0;
        void Walk(IUIAutomationElement element, string? parent, int depth)
        {
            context.Check();
            if (nodes.Count >= maxNodes) { truncated = true; return; }
            string id = $"n{nodes.Count + 1}";
            try
            {
                var password = element.CachedIsPassword != 0;
                var rect = element.CachedBoundingRectangle;
                var actions = new List<string>();
                foreach (var pattern in Patterns)
                {
                    try
                    {
                        if (element.GetCachedPattern(pattern.Id) != null && pattern.Name != "text")
                        {
                            if (pattern.Name == "expand_collapse") actions.AddRange(["expand", "collapse"]);
                            else actions.Add(pattern.Name);
                        }
                    }
                    catch (COMException) { /* Unsupported pattern. */ }
                }
                if (element.CachedIsKeyboardFocusable != 0) actions.Add("focus");
                var node = new Dictionary<string, object?>
                {
                    ["id"] = id, ["parentId"] = parent, ["depth"] = depth,
                    ["role"] = Roles.GetValueOrDefault(element.CachedControlType, "unknown"),
                    ["name"] = Limit(element.CachedName, 1000), ["automationId"] = Limit(element.CachedAutomationId, 1000),
                    ["enabled"] = element.CachedIsEnabled != 0, ["offscreen"] = element.CachedIsOffscreen != 0,
                    ["focused"] = element.CachedHasKeyboardFocus != 0, ["password"] = password,
                    ["bounds"] = new PixelRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top),
                    ["actions"] = actions
                };
                if (parameters.Flag("includeText") && !password)
                {
                    try
                    {
                        if (CachedPattern(element, 10002) is IUIAutomationValuePattern value) node["text"] = Limit(value.CurrentValue, 2000);
                        else if (CachedPattern(element, 10014) is IUIAutomationTextPattern text) node["text"] = text.DocumentRange.GetText(2000);
                    }
                    catch (COMException) { skipped++; }
                }
                references.Add(id, new(element, element.GetRuntimeId(), element.CachedName, element.CachedControlType));
                nodes.Add(node);
                var child = walker.GetFirstChildElementBuildCache(element, cache);
                if (depth >= maxDepth) { if (child != null) truncated = true; return; }
                while (child != null)
                {
                    context.Check();
                    if (nodes.Count >= maxNodes) { truncated = true; break; }
                    Walk(child, id, depth + 1);
                    child = walker.GetNextSiblingElementBuildCache(child, cache);
                }
            }
            catch (COMException) { skipped++; }
        }
        Walk(root, null, 0);
        context.Check();
        return new()
        {
            ["windowId"] = windowId, ["snapshotId"] = snapshots.Put(new(window, references), "snapshot"),
            ["coordinateSpace"] = "physical-screen-pixels", ["nodes"] = nodes, ["truncated"] = truncated, ["skipped"] = skipped
        };
    }
    public WindowRef TargetWindow(JsonElement parameters) => snapshots.Get(parameters.Required("snapshotId")).Window;
    public Dictionary<string, object?> Act(JsonElement parameters, WorkContext context)
    {
        var snapshot = snapshots.Get(parameters.Required("snapshotId"));
        snapshot.Window.Check();
        if (!snapshot.Nodes.TryGetValue(parameters.Required("target"), out var node))
            throw new DesktopException("STALE_REFERENCE", "Target was not in this snapshot.");
        var element = node.Element;
        if (!node.RuntimeId.SequenceEqual(element.GetRuntimeId()) || element.CurrentIsEnabled == 0 ||
            node.Name != element.CurrentName || node.ControlType != element.CurrentControlType)
            throw new DesktopException("STALE_REFERENCE", "Target changed or is disabled; observe again.");
        // Recheck ancestry; a retained COM element is not a permanent permission to another window.
        var parent = element;
        bool belongs = false;
        for (int depth = 0; parent != null && depth < 64; depth++)
        {
            context.Check();
            if (parent.CurrentNativeWindowHandle == snapshot.Window.Handle) { belongs = true; break; }
            parent = automation.RawViewWalker.GetParentElement(parent);
        }
        if (!belongs) throw new DesktopException("STALE_REFERENCE", "Target no longer belongs to the observed window.");
        var action = parameters.Required("action");
        bool verified = false;
        context.Check();
        switch (action)
        {
            case "invoke":
                var name = parameters.Text("actionName") ?? "invoke";
                switch (name)
                {
                    case "invoke": ((IUIAutomationInvokePattern)Pattern(element, 10000)).Invoke(); break;
                    case "toggle": ((IUIAutomationTogglePattern)Pattern(element, 10015)).Toggle(); break;
                    case "select": ((IUIAutomationSelectionItemPattern)Pattern(element, 10010)).Select(); break;
                    case "expand": ((IUIAutomationExpandCollapsePattern)Pattern(element, 10005)).Expand(); break;
                    case "collapse": ((IUIAutomationExpandCollapsePattern)Pattern(element, 10005)).Collapse(); break;
                    default: throw new DesktopException("UNSUPPORTED_ACTION", "Use invoke, toggle, select, expand or collapse.");
                }
                break;
            case "set_text":
                if (!parameters.TryGetProperty("text", out var text) || text.ValueKind != JsonValueKind.String || text.GetString()!.Length > 100_000)
                    throw new DesktopException("INVALID_REQUEST", "text must be a string of at most 100000 characters");
                var value = (IUIAutomationValuePattern)Pattern(element, 10002);
                if (value.CurrentIsReadOnly != 0) throw new DesktopException("READ_ONLY", "Target is read-only.");
                value.SetValue(text.GetString());
                context.Check();
                verified = element.CurrentIsPassword == 0 && value.CurrentValue == text.GetString();
                break;
            case "focus":
                Native.FocusWindow(snapshot.Window.Handle, context);
                element.SetFocus();
                verified = Native.GetForegroundWindow() == snapshot.Window.Handle && element.CurrentHasKeyboardFocus != 0;
                break;
            default: throw new DesktopException("UNSUPPORTED_ACTION", "Unsupported accessibility action.");
        }
        context.Check();
        return new() { ["accepted"] = true, ["verified"] = verified, ["action"] = action };
    }
    private static object Pattern(IUIAutomationElement element, int id)
    {
        try { return element.GetCurrentPattern(id) ?? throw new DesktopException("UNSUPPORTED_ACTION", "Control does not expose the requested UIA pattern."); }
        catch (COMException error) { throw new DesktopException("UNSUPPORTED_ACTION", $"UIA pattern unavailable: {error.Message}"); }
    }
    private static object? CachedPattern(IUIAutomationElement element, int id)
    {
        try { return element.GetCachedPattern(id); }
        catch (COMException) { return null; }
    }
    private static string Limit(string? text, int limit) => text is null ? "" : text[..Math.Min(text.Length, limit)];
    public void Clear() => snapshots.Clear();
    public void Dispose() { Clear(); if (Marshal.IsComObject(automation)) Marshal.ReleaseComObject(automation); }
}
