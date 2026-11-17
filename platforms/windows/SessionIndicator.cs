using System.Runtime.InteropServices;

namespace AgentBridgeLens.Windows;

internal sealed class SessionIndicator : IDisposable
{
    private Form? form;
    private int closing;
    public SessionIndicator(WindowRef target, bool input, Action stop)
    {
        using var ready = new ManualResetEventSlim();
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            bool signalled = false;
            try
            {
                using var window = new StopForm(stop)
                {
                    Text = "AgentBridgeLens 已连接", Width = 400, Height = 160, TopMost = true,
                    AutoScaleDimensions = new SizeF(96, 96), AutoScaleMode = AutoScaleMode.Dpi,
                    StartPosition = FormStartPosition.Manual, Location = new Point(24, 24),
                    FormBorderStyle = FormBorderStyle.FixedToolWindow
                };
                window.Controls.Add(new Label { Left = 12, Top = 10, Width = 360, Height = 55,
                    Text = $"{(input ? "允许控制" : "只读共享")}：{Native.Title(target.Handle)}\n停止快捷键：Ctrl + Alt + F12" });
                var button = new Button { Text = "停止连接", Left = 240, Top = 70, Width = 130 };
                button.Click += (_, _) => stop();
                window.Controls.Add(button);
                window.FormClosed += (_, _) => { if (Volatile.Read(ref closing) == 0) stop(); };
                window.Load += (_, _) => { form = window; signalled = true; ready.Set(); };
                Application.Run(window);
            }
            catch (Exception error)
            {
                failure = error;
                if (signalled) { Console.Error.WriteLine("Desktop stop panel failed: " + error.Message); stop(); }
            }
            finally { form = null; if (!signalled) ready.Set(); }
        }) { IsBackground = true, Name = "desktop-stop-panel" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        ready.Wait();
        if (failure != null) throw new DesktopException("CONSENT_FAILED", "Cannot show local stop panel: " + failure.Message);
    }
    public void Dispose()
    {
        Interlocked.Exchange(ref closing, 1);
        var current = form;
        try { if (current is { IsDisposed: false }) current.BeginInvoke(() => current.Close()); }
        catch (InvalidOperationException) { /* UI already closed by the user. */ }
    }
    private sealed class StopForm(Action stop) : Form
    {
        [DllImport("user32.dll")] private static extern bool RegisterHotKey(nint hwnd, int id, uint modifiers, uint key);
        [DllImport("user32.dll")] private static extern bool UnregisterHotKey(nint hwnd, int id);
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // Failure leaves the visible stop button available (another app may own the shortcut).
            if (!RegisterHotKey(Handle, 1, 0x4000 | 1 | 2, 0x7B)) Text += " · 请使用停止按钮";
        }
        protected override void OnHandleDestroyed(EventArgs e) { UnregisterHotKey(Handle, 1); base.OnHandleDestroyed(e); }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x0312 && message.WParam == 1) stop();
            base.WndProc(ref message);
        }
    }
}
