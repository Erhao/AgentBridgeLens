using System.Text.Json;

namespace AgentBridgeLens.Windows;

internal static class Input
{
    public static Dictionary<string, object?> Act(Capture capture, JsonElement parameters, WorkContext context)
    {
        var frame = capture.Frame(parameters.Required("screenshotId"));
        var action = parameters.Required("action");
        if (action is not ("press_keys" or "click" or "move" or "scroll"))
            throw new DesktopException("UNSUPPORTED_ACTION", "Unsupported input action.");
        context.Check();
        // Existing user modifiers/buttons must not be released or combined with AI input.
        foreach (var key in new[] { 1, 2, 4, 0x10, 0x11, 0x12, 0x5B, 0x5C })
            if (Native.GetAsyncKeyState(key) < 0) throw new DesktopException("USER_INPUT_ACTIVE", "Release mouse buttons and modifier keys before AI input.");
        if (action == "press_keys")
        {
            if (!parameters.TryGetProperty("keys", out var keys) || keys.ValueKind != JsonValueKind.Array || keys.GetArrayLength() is < 1 or > 8)
                throw new DesktopException("INVALID_REQUEST", "keys must contain 1–8 named Windows keys.");
            var codes = KeyboardNames.Chord(keys.EnumerateArray().Select(key => key.ValueKind == JsonValueKind.String
                ? key.GetString()! : throw new DesktopException("INVALID_KEY", "Windows requires named keys, not Linux evdev numbers.")));
            foreach (var key in codes) if (Native.GetAsyncKeyState(key) < 0)
                throw new DesktopException("USER_INPUT_ACTIVE", "A requested key is already held by the user.");
            var pressed = new Stack<ushort>();
            Exception? releaseError = null;
            try
            {
                foreach (var code in codes)
                {
                    context.Check();
                    capture.Frame(parameters.Required("screenshotId"));
                    Native.Send(Native.Key(code, false));
                    pressed.Push(code);
                }
            }
            finally
            {
                while (pressed.TryPop(out var code))
                    try { Native.Send(Native.Key(code, true)); } catch (Exception error) { releaseError = error; }
                if (releaseError != null) { capture.Close(); throw new DesktopException("INPUT_RELEASE_FAILED", "Could not release injected keys; session revoked. " + releaseError.Message); }
            }
        }
        else
        {
            var (x, y) = InputCoordinates.FromImage(parameters.Number("x"), parameters.Number("y"), frame.Width, frame.Height, frame.Bounds);
            var button = parameters.Text("button") ?? "left";
            if (action == "click" && button is not ("left" or "right" or "middle"))
                throw new DesktopException("INVALID_REQUEST", "Unknown mouse button.");
            var dx = parameters.TryGetProperty("dx", out _) ? parameters.Number("dx") : 0;
            var dy = parameters.TryGetProperty("dy", out _) ? parameters.Number("dy") : 0;
            if (action == "scroll" && (Math.Abs(dx) > 1000 || Math.Abs(dy) > 1000 || (dx == 0 && dy == 0) || dx != Math.Truncate(dx) || dy != Math.Truncate(dy)))
                throw new DesktopException("INVALID_REQUEST", "Scroll requires nonzero integer dx/dy, at most 1000 wheel units each.");
            // WGC can capture occluded content. Never send a click through another window.
            if (Native.GetAncestor(Native.WindowFromPoint(new Native.Point { X = x, Y = y }), 2) != frame.Window.Handle)
                throw new DesktopException("TARGET_OCCLUDED", "The point is covered by another window; uncover it and capture again.");
            var normalized = InputCoordinates.Normalize(x, y, frame.Desktop);
            Native.Send(Native.Mouse(0x0001 | 0x8000 | 0x4000, normalized.X, normalized.Y)); // MOVE | ABSOLUTE | VIRTUALDESK
            context.Check();
            capture.Frame(parameters.Required("screenshotId"));
            if (Native.GetAncestor(Native.WindowFromPoint(new Native.Point { X = x, Y = y }), 2) != frame.Window.Handle)
                throw new DesktopException("TARGET_OCCLUDED", "Point became occluded; capture again.");
            if (action == "click")
            {
                var (down, up) = button switch
                {
                    "left" => (2u, 4u), "right" => (8u, 16u), "middle" => (32u, 64u),
                    _ => throw new DesktopException("INVALID_REQUEST", "Unknown mouse button.")
                };
                bool pressed = false;
                try { context.Check(); Native.Send(Native.Mouse(down)); pressed = true; }
                finally
                {
                    if (pressed)
                    {
                        try { Native.Send(Native.Mouse(up)); }
                        catch { capture.Close(); throw new DesktopException("INPUT_RELEASE_FAILED", "Could not release injected mouse button; session revoked."); }
                    }
                }
            }
            else if (action == "scroll")
            {
                // Public convention: positive dy scrolls down; Windows vertical wheel uses the opposite sign.
                if (dy != 0) Native.Send(Native.Mouse(0x0800, data: unchecked((uint)(int)-dy)));
                if (dx != 0) { context.Check(); capture.Frame(parameters.Required("screenshotId")); Native.Send(Native.Mouse(0x1000, data: unchecked((uint)(int)dx))); }
            }
            else if (action != "move") throw new DesktopException("UNSUPPORTED_ACTION", "Unsupported input action.");
        }
        context.Check();
        return new() { ["action"] = action, ["accepted"] = true, ["verified"] = false,
            ["verification"] = "Observe again to verify task outcome. Input delivery does not prove application success." };
    }
}
