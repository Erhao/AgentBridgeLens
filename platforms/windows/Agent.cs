using System.Text.Json;

namespace AgentBridgeLens.Windows;

internal sealed class Agent(Action localStop) : IDisposable
{
    private readonly string sessionId = $"desktop-{Guid.NewGuid():N}";
    private readonly References<WindowRef> windows = new(TimeSpan.FromMinutes(5), 512);
    private readonly Capture capture = new();
    private Accessibility? accessibility;
    private SessionIndicator? indicator;
    private string? approvedWindowId;
    private Accessibility A11y => accessibility ??= new();

    public Dictionary<string, object?> Dispatch(string tool, JsonElement parameters, WorkContext context)
    {
        if (tool == "desktop_get_capabilities") return new()
        {
            ["sessionId"] = sessionId, ["platform"] = "win32", ["graphicalSession"] = Native.DesktopAvailable(),
            ["accessibility"] = new { source = "uia3", available = Native.DesktopAvailable(), completeWindowList = false },
            ["capture"] = new { source = "Windows.Graphics.Capture", available = Capture.Supported, active = capture.Target != null,
                inputAllowed = capture.InputAllowed, windowId = approvedWindowId },
            ["limitations"] = new[] { "Unlocked interactive Windows desktop required; no Session 0 or UAC secure desktop", "One locally approved window; separate dialogs require a new session",
                "UIA coverage depends on the app; bounded polling, no virtualized-item realization", "Input requires foreground/unoccluded window and a fresh screenshot; no automatic retry", "No client isolation or cross-Bridge input coordination" }
        };
        if (tool == "desktop_stop")
        {
            Stop();
            return new() { ["sessionId"] = sessionId, ["stopped"] = true, ["sharingClosed"] = true };
        }
        if (parameters.Text("sessionId") != sessionId) throw new DesktopException("STALE_SESSION", "Missing or stale sessionId. Call desktop_get_capabilities again.");
        context.Check();
        Native.RequireDesktop();
        Dictionary<string, object?> result;
        switch (tool)
        {
            case "desktop_list_apps":
                result = new() { ["apps"] = ListWindows(parameters, context).GroupBy(w => w["appId"]).Select(group => new
                { appId = group.Key, pid = group.First()["pid"], name = group.First()["name"] }).ToArray() };
                break;
            case "desktop_list_windows": result = new() { ["windows"] = ListWindows(parameters, context) }; break;
            case "desktop_observe":
                var window = windows.Get(parameters.Required("windowId"));
                result = A11y.Observe(window, parameters.Required("windowId"), parameters, context);
                if (parameters.Flag("includeScreenshot"))
                {
                    if (capture.Target != window) throw new DesktopException("PERMISSION_REQUIRED", "Approve this window before including a screenshot.");
                    ValidateStream(parameters);
                    foreach (var pair in capture.Screenshot(context)) result[pair.Key] = pair.Value;
                }
                break;
            case "desktop_start_session":
                if (parameters.Flag("multiple")) throw new DesktopException("UNSUPPORTED_CAPABILITY", "Windows currently supports one approved window per session.");
                StopSharing();
                accessibility?.Clear();
                var target = windows.Get(parameters.Required("windowId"));
                try
                {
                    capture.Start(target, parameters.Flag("input"), context);
                    indicator = new SessionIndicator(target, capture.InputAllowed, localStop);
                    approvedWindowId = parameters.Required("windowId");
                }
                catch { StopSharing(); throw; }
                result = new() { ["active"] = true, ["inputAllowed"] = capture.InputAllowed, ["windowId"] = parameters.Required("windowId"),
                    ["streams"] = new[] { new { streamId = 1, windowId = parameters.Required("windowId") } } };
                break;
            case "desktop_capture_screenshot": ValidateStream(parameters); result = capture.Screenshot(context); break;
            case "desktop_act":
                try
                {
                    if (parameters.Text("action") is "invoke" or "set_text" or "focus")
                    {
                        capture.RequireInput(A11y.TargetWindow(parameters));
                        result = A11y.Act(parameters, context);
                    }
                    else result = Input.Act(capture, parameters, context);
                }
                finally { accessibility?.Clear(); capture.ClearFrames(); }
                break;
            case "desktop_wait_for":
                if (parameters.Text("name") == null && parameters.Text("role") == null)
                    throw new DesktopException("INVALID_REQUEST", "wait_for requires an exact name and/or role.");
                while (true)
                {
                    context.Check();
                    result = A11y.Observe(windows.Get(parameters.Required("windowId")), parameters.Required("windowId"),
                        JsonSerializer.SerializeToElement(new { maxDepth = 12, maxNodes = 1000 }), context);
                    var matches = ((List<Dictionary<string, object?>>)result["nodes"]!).Where(node =>
                        (parameters.Text("name") == null || (string?)node["name"] == parameters.Text("name")) &&
                        (parameters.Text("role") == null || (string?)node["role"] == parameters.Text("role")))
                        .Select(node => node["id"]).ToArray();
                    if (matches.Length > 0) { result["matches"] = matches; break; }
                    context.Pause(200);
                }
                break;
            default: throw new DesktopException("UNKNOWN_TOOL", "Unknown desktop tool.");
        }
        context.Check();
        result["sessionId"] = sessionId;
        return result;
    }
    private List<Dictionary<string, object?>> ListWindows(JsonElement parameters, WorkContext context)
    {
        var result = new List<Dictionary<string, object?>>();
        var handles = new List<nint>();
        Native.EnumWindows((hwnd, _) => { if (Native.IsWindowVisible(hwnd) && Native.Pid(hwnd) != Environment.ProcessId && Native.Title(hwnd).Length > 0) handles.Add(hwnd); return handles.Count < 512; }, 0);
        foreach (var hwnd in handles)
        {
            context.Check();
            try
            {
                var reference = WindowRef.Create(hwnd);
                var appId = $"process-{reference.Pid}-{reference.Started}";
                if (parameters.Text("appId") is { } filter && filter != appId) continue;
                result.Add(new()
                {
                    ["windowId"] = windows.Put(reference, "window"), ["appId"] = appId,
                    ["pid"] = reference.Pid, ["name"] = Native.Title(hwnd), ["role"] = "window",
                    ["bounds"] = Native.Bounds(hwnd), ["dpi"] = Native.GetDpiForWindow(hwnd),
                    ["foreground"] = Native.GetForegroundWindow() == hwnd, ["minimized"] = Native.IsIconic(hwnd)
                });
            }
            catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException or ArgumentException)
            { /* A window can disappear while enumerating it. */ }
        }
        return result;
    }
    private static void ValidateStream(JsonElement parameters) => parameters.Integer("streamId", 1, 1, 1);
    private void StopSharing() { indicator?.Dispose(); indicator = null; capture.Close(); approvedWindowId = null; }
    private void Stop() { StopSharing(); windows.Clear(); accessibility?.Clear(); }
    public void Dispose() { Stop(); accessibility?.Dispose(); }
}
