namespace AgentBridgeLens.Windows;

internal static class Consent
{
    // This STA thread owns only consent UI. UIA always remains on the MTA worker.
    public static void Request(WindowRef target, bool input, WorkContext context)
    {
        using var done = new ManualResetEventSlim();
        bool allowed = false;
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                using var form = new Form
                {
                    Text = "AgentBridgeLens · 桌面连接", Width = 540, Height = 240,
                    AutoScaleDimensions = new SizeF(96, 96), AutoScaleMode = AutoScaleMode.Dpi,
                    StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog,
                    MaximizeBox = false, MinimizeBox = false, TopMost = true
                };
                var label = new Label
                {
                    Left = 20, Top = 18, Width = 480, Height = 110,
                    Text = $"AI 请求访问窗口：\n{Native.Title(target.Handle)}\n\n" +
                        (input ? "允许后可截图、操作控件并发送鼠标键盘输入。" : "允许后可截图；控件操作和鼠标键盘输入保持关闭。") +
                        "\n本次许可仅适用于该窗口，停止或断开后失效。"
                };
                var deny = new Button { Text = "拒绝", Left = 300, Top = 145, Width = 90, DialogResult = DialogResult.Cancel };
                var allow = new Button { Text = "允许本次", Left = 400, Top = 145, Width = 100, DialogResult = DialogResult.OK };
                form.Controls.AddRange([label, deny, allow]);
                form.AcceptButton = deny; // Enter never silently grants desktop control.
                form.CancelButton = deny;
                using var timer = new System.Windows.Forms.Timer { Interval = 100 };
                timer.Tick += (_, _) =>
                {
                    try { context.Check(); }
                    catch { form.DialogResult = DialogResult.Cancel; form.Close(); }
                };
                timer.Start();
                allowed = form.ShowDialog() == DialogResult.OK;
            }
            catch (Exception error) { failure = error; }
            finally { done.Set(); }
        }) { IsBackground = true, Name = "desktop-consent" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        // Wait for the UI thread to close before disposing its completion event.
        done.Wait();
        context.Check();
        if (failure != null) throw new DesktopException("CONSENT_FAILED", failure.Message);
        if (!allowed) throw new DesktopException("PERMISSION_DENIED", "Local user declined window capture/control.");
        target.Check();
    }
}
