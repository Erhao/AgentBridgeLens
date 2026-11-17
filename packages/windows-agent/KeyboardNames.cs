namespace AgentBridgeLens.Windows;

internal static class KeyboardNames
{
    public static ushort[] Chord(IEnumerable<string> names)
    {
        var keys = names.Select(Parse).ToArray();
        if (keys.Length is < 1 or > 8 || keys.Distinct().Count() != keys.Length)
            throw new DesktopException("INVALID_KEY", "Use 1 to 8 distinct named keys.");
        if (keys.Contains((ushort)0x5B) ||
            (keys.Contains((ushort)0x12) && (keys.Contains((ushort)0x09) || keys.Contains((ushort)0x1B))) ||
            (keys.Contains((ushort)0x11) && keys.Contains((ushort)0x1B)) ||
            (keys.Contains((ushort)0x11) && keys.Contains((ushort)0x12) && keys.Contains((ushort)0x2E)))
            throw new DesktopException("INVALID_KEY", "Desktop switching and system launcher shortcuts are outside the approved window scope.");
        return keys;
    }
    public static ushort Parse(string name)
    {
        name = name.ToUpperInvariant();
        if (name.Length == 1 && (name[0] is >= 'A' and <= 'Z' or >= '0' and <= '9')) return name[0];
        if (name.StartsWith('F') && int.TryParse(name[1..], out var function) && function is >= 1 and <= 24)
            return (ushort)(0x70 + function - 1);
        return name switch
        {
            "CTRL" or "CONTROL" => 0x11, "ALT" => 0x12, "SHIFT" => 0x10,
            "WIN" => 0x5B, "ENTER" => 0x0D, "ESC" or "ESCAPE" => 0x1B,
            "TAB" => 0x09, "SPACE" => 0x20, "BACKSPACE" => 0x08, "DELETE" => 0x2E,
            "INSERT" => 0x2D, "HOME" => 0x24, "END" => 0x23, "PAGEUP" => 0x21,
            "PAGEDOWN" => 0x22, "LEFT" => 0x25, "UP" => 0x26, "RIGHT" => 0x27, "DOWN" => 0x28,
            _ => throw new DesktopException("INVALID_KEY", $"Unsupported key name: {name}. Use named shortcuts; set_text is for text.")
        };
    }
}
