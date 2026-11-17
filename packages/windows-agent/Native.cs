using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentBridgeLens.Windows;

internal static class Native
{
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] internal struct Point { public int X, Y; }
    internal delegate bool EnumWindow(nint hwnd, nint param);
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumWindow callback, nint param);
    [DllImport("user32.dll")] internal static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] internal static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(nint hwnd, int command);
    [DllImport("user32.dll")] internal static extern nint GetAncestor(nint hwnd, uint flag);
    [DllImport("user32.dll")] internal static extern nint WindowFromPoint(Point point);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(nint hwnd, out Rect rect);
    [DllImport("user32.dll")] internal static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(nint hwnd, StringBuilder text, int length);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(nint desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetUserObjectInformation(nint handle, int index, StringBuilder text, uint length, out uint needed);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(nint hwnd, uint attribute, out Rect rect, int length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(nint process, uint access, out nint token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(nint token, int info, nint data, int length, out int needed);
    [DllImport("advapi32.dll")] private static extern nint GetSidSubAuthorityCount(nint sid);
    [DllImport("advapi32.dll")] private static extern nint GetSidSubAuthority(nint sid, uint index);

    public static string Title(nint hwnd)
    {
        var text = new StringBuilder(1024);
        GetWindowText(hwnd, text, text.Capacity);
        return text.ToString();
    }
    public static uint Pid(nint hwnd) { GetWindowThreadProcessId(hwnd, out var pid); return pid; }
    public static PixelRect Bounds(nint hwnd)
    {
        if (DwmGetWindowAttribute(hwnd, 9, out var rect, Marshal.SizeOf<Rect>()) != 0 && !GetWindowRect(hwnd, out rect))
            throw new DesktopException("WINDOW_UNAVAILABLE", "Cannot read window bounds.");
        return new(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }
    public static PixelRect VirtualDesktop() => new(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));
    public static bool DesktopAvailable()
    {
        if (!Environment.UserInteractive || Process.GetCurrentProcess().SessionId == 0) return false;
        var desktop = OpenInputDesktop(0, false, 1); // DESKTOP_READOBJECTS, no switch/elevation.
        if (desktop == 0) return false;
        try
        {
            var name = new StringBuilder(256);
            return GetUserObjectInformation(desktop, 2, name, 512, out _) && name.ToString().Equals("Default", StringComparison.OrdinalIgnoreCase);
        }
        finally { CloseDesktop(desktop); }
    }
    public static void RequireDesktop()
    {
        if (!DesktopAvailable()) throw new DesktopException("NO_DESKTOP", "An unlocked interactive Windows user session is required. UAC secure desktop, lock screen and Session 0 are unsupported.");
    }
    public static void FocusWindow(nint hwnd, WorkContext context)
    {
        context.Check();
        if (IsIconic(hwnd))
        {
            ShowWindowAsync(hwnd, 9); // SW_RESTORE; request only, then verify.
            for (int attempt = 0; attempt < 10 && IsIconic(hwnd); attempt++) context.Pause(50);
            if (IsIconic(hwnd)) throw new DesktopException("WINDOW_UNAVAILABLE", "Windows did not restore the approved window.");
        }
        context.Check();
        if (GetForegroundWindow() != hwnd) SetForegroundWindow(hwnd);
        if (GetForegroundWindow() != hwnd)
            throw new DesktopException("FOCUS_CHANGED", "Windows denied foreground activation. Activate the approved window locally and observe again.");
    }
    public static int Integrity(uint pid)
    {
        var process = OpenProcess(0x1000, false, pid);
        if (process == 0) throw new DesktopException("PERMISSION_DENIED", "Cannot inspect target process permissions.");
        nint token = 0, buffer = 0;
        try
        {
            if (!OpenProcessToken(process, 8, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            GetTokenInformation(token, 25, 0, 0, out var size); // TokenIntegrityLevel
            if (size <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            buffer = Marshal.AllocHGlobal(size);
            if (!GetTokenInformation(token, 25, buffer, size, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var sid = Marshal.ReadIntPtr(buffer);
            var count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
        }
        finally
        {
            if (buffer != 0) Marshal.FreeHGlobal(buffer);
            if (token != 0) CloseHandle(token);
            CloseHandle(process);
        }
    }
    public static void RequirePermission(nint hwnd)
    {
        if (Integrity(Pid(hwnd)) > Integrity((uint)Environment.ProcessId))
            throw new DesktopException("PERMISSION_DENIED", "Target is elevated above the executor. Run the target as a normal user; automatic elevation and UIAccess are not provided.");
    }

    // Union must include MOUSEINPUT, even for keyboard events, to preserve INPUT's native size.
    [StructLayout(LayoutKind.Sequential)] internal struct Input { public uint Type; public InputUnion Data; }
    [StructLayout(LayoutKind.Explicit)] internal struct InputUnion
    {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct MouseInput
    {
        public int X, Y;
        public uint Data, Flags, Time;
        public nuint Extra;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct KeyboardInput
    {
        public ushort Key, Scan;
        public uint Flags, Time;
        public nuint Extra;
    }
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
    public static void Send(Input input)
    {
        if (SendInput(1, [input], Marshal.SizeOf<Input>()) != 1)
            throw new DesktopException("INPUT_FAILED", "Windows rejected input (possibly UIPI). Outcome may be unknown; observe before retrying.");
    }
    public static Input Key(ushort key, bool up) => new() { Type = 1, Data = new() { Keyboard = new()
    { Key = key, Flags = (up ? 2u : 0u) | (key is >= 0x21 and <= 0x2E ? 1u : 0u) } } };
    public static Input Mouse(uint flags, int x = 0, int y = 0, uint data = 0) => new() { Type = 0, Data = new() { Mouse = new() { Flags = flags, X = x, Y = y, Data = data } } };
}

internal sealed record WindowRef(nint Handle, uint Pid, long Started)
{
    public static WindowRef Create(nint hwnd)
    {
        var pid = Native.Pid(hwnd);
        using var process = Process.GetProcessById((int)pid);
        return new(hwnd, pid, process.StartTime.ToUniversalTime().Ticks);
    }
    public void Check()
    {
        Native.RequireDesktop();
        if (!Native.IsWindow(Handle) || Native.Pid(Handle) != Pid)
            throw new DesktopException("STALE_REFERENCE", "Window closed or its handle was reused. List windows again.");
        using var process = Process.GetProcessById((int)Pid);
        if (process.StartTime.ToUniversalTime().Ticks != Started)
            throw new DesktopException("STALE_REFERENCE", "Target process restarted. List windows again.");
        Native.RequirePermission(Handle);
    }
}
