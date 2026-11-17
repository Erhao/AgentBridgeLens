using System.Diagnostics;
using System.Text.Json;
using AgentBridgeLens.Windows;
using Interop.UIAutomationClient;

internal static class Program
{
    [MTAThread]
    private static void Main(string[] args)
    {
        if (args.FirstOrDefault() == "--fixture") { Fixture(args[1]); return; }
        if (args.FirstOrDefault() == "--protocol-worker")
        {
            typeof(Agent).Assembly.EntryPoint!.Invoke(null, null);
            return;
        }
        using var agent = new Agent(() => { });
        var caps = Call(agent, "desktop_get_capabilities", new { });
        Check(System.Runtime.InteropServices.Marshal.SizeOf<Native.Input>() == 40, "Native INPUT layout on x64/ARM64");
        Check((string)caps["platform"]! == "win32", "Capabilities platform");
        Error("STALE_SESSION", () => Call(agent, "desktop_list_windows", new { sessionId = "old" }));
        if (!Native.DesktopAvailable())
        {
            if (Environment.GetEnvironmentVariable("ABL_REQUIRE_INTERACTIVE") == "1") throw new Exception("Interactive Windows desktop required for this acceptance run.");
            Console.WriteLine("SKIP interactive UIA/WGC checks: runner has no unlocked interactive desktop.");
            return;
        }
        var title = $"AgentBridgeLens test {Guid.NewGuid():N}";
        var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        if (Path.GetFileNameWithoutExtension(Environment.ProcessPath) == "dotnet") start.ArgumentList.Add(typeof(Program).Assembly.Location);
        start.ArgumentList.Add("--fixture"); start.ArgumentList.Add(title);
        using var fixture = Process.Start(start)!;
        try
        {
            var handleLine = fixture.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15)).GetAwaiter().GetResult();
            var hwnd = (nint)long.Parse(handleLine!);
            var context = new WorkContext(CancellationToken.None, TimeSpan.FromSeconds(30));
            var session = (string)caps["sessionId"]!;
            var windows = (List<Dictionary<string, object?>>)Call(agent, "desktop_list_windows", new { sessionId = session })["windows"]!;
            var windowId = (string)windows.Single(window => (string)window["name"]! == title)["windowId"]!;
            var observed = Call(agent, "desktop_observe", new { sessionId = session, windowId, includeText = true });
            var nodes = (List<Dictionary<string, object?>>)observed["nodes"]!;
            var editor = nodes.Single(node => (string)node["automationId"]! == "editor");
            var password = nodes.Single(node => (string)node["automationId"]! == "password");
            Check(!password.ContainsKey("text"), "Password contents omitted");
            Error("PERMISSION_REQUIRED", () => Call(agent, "desktop_act", new
            { sessionId = session, action = "set_text", snapshotId = observed["snapshotId"], target = editor["id"], text = "should not be entered" }));

            // Test driver approves only its own process's consent dialog, inside this isolated fixture run.
            using var capture = new Capture();
            var approving = ApproveOwnDialog();
            capture.Start(WindowRef.Create(hwnd), false, context);
            approving.GetAwaiter().GetResult();
            Error("PERMISSION_REQUIRED", () => capture.RequireInput(WindowRef.Create(hwnd)));
            if (Capture.Supported)
            {
                var png = capture.Screenshot(context);
                var data = JsonSerializer.SerializeToElement(png).GetProperty("screenshot");
                var bytes = Convert.FromBase64String(data.GetProperty("data").GetString()!);
                Check(bytes.Take(8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }), "WGC returns PNG");
                using var image = new Bitmap(new MemoryStream(bytes));
                var color = image.GetPixel(image.Width * 3 / 4, image.Height * 3 / 4);
                Check(color.G > 200 && color.B > 200 && color.R < 50, "WGC captured the cyan fixture window");
                Console.WriteLine("PASS WGC captured the expected fixture pixels.");
            }
            else Console.WriteLine("SKIP WGC capture: GraphicsCaptureSession.IsSupported returned false.");
            capture.Close();

            using var a11y = new AgentBridgeLens.Windows.Accessibility();
            var parameters = JsonSerializer.SerializeToElement(new { includeText = true });
            var snapshot = a11y.Observe(WindowRef.Create(hwnd), windowId, parameters, context);
            var textNode = ((List<Dictionary<string, object?>>)snapshot["nodes"]!).Single(node => (string)node["automationId"]! == "editor");
            var changed = a11y.Act(JsonSerializer.SerializeToElement(new
            { action = "set_text", snapshotId = snapshot["snapshotId"], target = textNode["id"], text = "你好 Windows 👋" }), context);
            Check((bool)changed["verified"]!, "UIA Unicode text read-back");
            a11y.Clear();
            Error("STALE_REFERENCE", () => a11y.TargetWindow(JsonSerializer.SerializeToElement(new { snapshotId = snapshot["snapshotId"] })));
            TestProtocol(title);
            var stopped = Call(agent, "desktop_stop", new { });
            Check((bool)stopped["sharingClosed"]!, "Stop clears session");
            Error("STALE_REFERENCE", () => Call(agent, "desktop_observe", new { sessionId = session, windowId }));
            Console.WriteLine("PASS interactive UIA, permission gate, Unicode read-back, protocol cancellation, button invocation and reference invalidation.");
        }
        finally { if (!fixture.HasExited) fixture.Kill(true); fixture.WaitForExit(); }
    }
    private static Dictionary<string, object?> Call(Agent agent, string tool, object parameters) =>
        agent.Dispatch(tool, JsonSerializer.SerializeToElement(parameters), new(CancellationToken.None, TimeSpan.FromSeconds(30)));
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static void Error(string code, Action action)
    {
        try { action(); throw new Exception("Expected " + code); }
        catch (DesktopException error) { Check(error.Code == code, $"Expected {code}, got {error.Code}"); }
    }
    private static Task ApproveOwnDialog() => ApproveDialog(Environment.ProcessId);
    private static Task ApproveDialog(int pid) => Task.Run(() =>
    {
        IUIAutomation automation = new CUIAutomation();
        var process = automation.CreatePropertyCondition(30002, pid);
        var title = automation.CreatePropertyCondition(30005, "AgentBridgeLens · 桌面连接");
        var filter = automation.CreateAndCondition(process, title);
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < TimeSpan.FromSeconds(15))
        {
            var dialog = automation.GetRootElement().FindFirst(TreeScope.TreeScope_Children, filter);
            if (dialog != null)
            {
                var button = dialog.FindFirst(TreeScope.TreeScope_Descendants, automation.CreatePropertyCondition(30005, "允许本次"));
                if (button?.GetCurrentPattern(10000) is IUIAutomationInvokePattern invoke) { invoke.Invoke(); return; }
            }
            Thread.Sleep(50);
        }
        throw new Exception("Own consent dialog did not appear.");
    });
    private static void TestProtocol(string title)
    {
        using var worker = new ProtocolWorker();
        var caps = worker.Call("desktop_get_capabilities", new { }).GetAwaiter().GetResult().GetProperty("result");
        var sessionId = caps.GetProperty("sessionId").GetString();
        string Window()
        {
            var response = worker.Call("desktop_list_windows", new { sessionId }).GetAwaiter().GetResult();
            return response.GetProperty("result").GetProperty("windows").EnumerateArray()
                .Single(window => window.GetProperty("name").GetString() == title).GetProperty("windowId").GetString()!;
        }
        var windowId = Window();
        var pending = worker.Call("desktop_start_session", new { sessionId, windowId, input = true });
        Thread.Sleep(300);
        var stopped = worker.Call("desktop_stop", new { }).GetAwaiter().GetResult();
        Check(stopped.GetProperty("result").GetProperty("sharingClosed").GetBoolean(), "Protocol stop during consent");
        Check(pending.GetAwaiter().GetResult().GetProperty("error").GetProperty("code").GetString() == "CANCELLED", "Consent cancellation");
        windowId = Window();
        var approving = ApproveDialog(worker.Pid);
        var started = worker.Call("desktop_start_session", new { sessionId, windowId, input = true }).GetAwaiter().GetResult();
        approving.GetAwaiter().GetResult();
        Check(started.GetProperty("result").GetProperty("inputAllowed").GetBoolean(), "Locally approved protocol session");
        var snapshot = worker.Call("desktop_observe", new { sessionId, windowId }).GetAwaiter().GetResult().GetProperty("result");
        var snapshotId = snapshot.GetProperty("snapshotId").GetString();
        var target = snapshot.GetProperty("nodes").EnumerateArray().Single(node => node.GetProperty("automationId").GetString() == "editor").GetProperty("id").GetString();
        var changed = worker.Call("desktop_act", new { sessionId, snapshotId, target, action = "set_text", text = "协议输入 👋" }).GetAwaiter().GetResult();
        Check(changed.GetProperty("result").GetProperty("verified").GetBoolean(), "Production protocol Unicode read-back");
        var stale = worker.Call("desktop_act", new { sessionId, snapshotId, target, action = "focus" }).GetAwaiter().GetResult();
        Check(stale.GetProperty("error").GetProperty("code").GetString() == "STALE_REFERENCE", "Production action invalidates snapshot");
        snapshot = worker.Call("desktop_observe", new { sessionId, windowId }).GetAwaiter().GetResult().GetProperty("result");
        snapshotId = snapshot.GetProperty("snapshotId").GetString();
        target = snapshot.GetProperty("nodes").EnumerateArray().Single(node => node.GetProperty("automationId").GetString() == "save").GetProperty("id").GetString();
        var invoked = worker.Call("desktop_act", new { sessionId, snapshotId, target, action = "invoke" }).GetAwaiter().GetResult();
        Check(invoked.GetProperty("result").GetProperty("accepted").GetBoolean(), "Invoke delivered");
        var saved = worker.Call("desktop_wait_for", new { sessionId, windowId, name = "已保存", timeoutMs = 5000 }).GetAwaiter().GetResult();
        Check(saved.GetProperty("result").GetProperty("matches").GetArrayLength() > 0, "Button changed fixture state");
        var waiting = worker.Call("desktop_wait_for", new { sessionId, windowId, name = "never-appears" });
        Thread.Sleep(150);
        worker.Call("desktop_stop", new { }).GetAwaiter().GetResult();
        Check(waiting.GetAwaiter().GetResult().GetProperty("error").GetProperty("code").GetString() == "CANCELLED", "Protocol wait cancellation");
    }
    private static void Fixture(string title)
    {
        var thread = new Thread(() =>
        {
            using var form = new Form { Text = title, Width = 640, Height = 400, BackColor = Color.Cyan };
            var editor = new TextBox { Name = "editor", AccessibleName = "编辑内容", Text = "initial", Left = 20, Top = 20, Width = 400 };
            var password = new TextBox { Name = "password", AccessibleName = "密码", Text = "not-for-agent", UseSystemPasswordChar = true, Left = 20, Top = 60, Width = 400 };
            var label = new Label { AccessibleName = "状态", Text = "待保存", Left = 20, Top = 150, Width = 300 };
            var save = new Button { Name = "save", Text = "保存", Left = 20, Top = 100 };
            save.Click += (_, _) => { label.Text = "已保存"; label.AccessibleName = "已保存"; };
            form.Controls.AddRange([editor, password, save, label]);
            form.Shown += (_, _) => Console.WriteLine(form.Handle.ToInt64());
            Application.Run(form);
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start(); thread.Join();
    }
}

internal sealed class ProtocolWorker : IDisposable
{
    private readonly Process process;
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> pending = new();
    private readonly object writeLock = new();
    private int sequence;
    public int Pid => process.Id;
    public ProtocolWorker()
    {
        var start = new ProcessStartInfo(Environment.ProcessPath!)
        { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        if (Path.GetFileNameWithoutExtension(Environment.ProcessPath) == "dotnet") start.ArgumentList.Add(typeof(Program).Assembly.Location);
        start.ArgumentList.Add("--protocol-worker");
        process = Process.Start(start)!;
        process.ErrorDataReceived += (_, message) => { if (message.Data != null) Console.Error.WriteLine(message.Data); };
        process.BeginErrorReadLine();
        _ = Task.Run(async () =>
        {
            try
            {
                while (await process.StandardOutput.ReadLineAsync() is { } line)
                {
                    using var document = JsonDocument.Parse(line);
                    var response = document.RootElement;
                    if (pending.TryRemove(response.GetProperty("id").GetString()!, out var completion)) completion.TrySetResult(response.Clone());
                }
            }
            finally { foreach (var item in pending.Values) item.TrySetException(new Exception("Protocol worker disconnected")); }
        });
    }
    public Task<JsonElement> Call(string tool, object parameters)
    {
        var id = Interlocked.Increment(ref sequence).ToString();
        var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = completion;
        lock (writeLock)
        {
            process.StandardInput.WriteLine(JsonSerializer.Serialize(new { id, tool, @params = parameters }));
            process.StandardInput.Flush();
        }
        return completion.Task.WaitAsync(TimeSpan.FromSeconds(35));
    }
    public void Dispose()
    {
        process.StandardInput.Close();
        if (!process.WaitForExit(5000)) process.Kill(true);
        process.Dispose();
    }
}
