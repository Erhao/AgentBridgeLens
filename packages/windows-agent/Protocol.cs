using System.Diagnostics;
using System.Text.Json;

namespace AgentBridgeLens.Windows;

internal sealed class DesktopException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal static class Json
{
    public static string? Text(this JsonElement value, string name) =>
        value.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() : null;
    public static string Required(this JsonElement value, string name) => value.Text(name) is { Length: > 0 } text
        ? text : throw new DesktopException("INVALID_REQUEST", $"Missing {name}");
    public static bool Flag(this JsonElement value, string name) => value.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.True;
    public static int Integer(this JsonElement value, string name, int fallback, int min, int max)
    {
        if (!value.TryGetProperty(name, out var item)) return fallback;
        if (!item.TryGetInt32(out var number) || number < min || number > max)
            throw new DesktopException("INVALID_REQUEST", $"{name} must be between {min} and {max}");
        return number;
    }
    public static double Number(this JsonElement value, string name)
    {
        if (!value.TryGetProperty(name, out var item) || !item.TryGetDouble(out var number) || !double.IsFinite(number))
            throw new DesktopException("INVALID_REQUEST", $"{name} must be a finite number");
        return number;
    }
}

internal sealed class WorkContext(CancellationToken cancellation, TimeSpan timeout)
{
    private readonly long started = Stopwatch.GetTimestamp();
    public CancellationToken Cancellation { get; } = cancellation;
    public void Check()
    {
        if (Cancellation.IsCancellationRequested)
            throw new DesktopException("CANCELLED", "Desktop work stopped. An action may have occurred; observe again before retrying.");
        if (Stopwatch.GetElapsedTime(started) >= timeout)
            throw new DesktopException("TIMEOUT", "Desktop operation timed out; observe before retrying actions.");
    }
    public void Pause(int milliseconds)
    {
        Check();
        Cancellation.WaitHandle.WaitOne(milliseconds);
        Check();
    }
}

internal sealed class References<T>(TimeSpan ttl, int capacity) where T : class
{
    private readonly Dictionary<string, (long Time, T Value)> items = [];
    public string Put(T value, string prefix)
    {
        foreach (var key in items.Where(pair => Stopwatch.GetElapsedTime(pair.Value.Time) >= ttl).Select(pair => pair.Key).ToArray())
            items.Remove(key);
        while (items.Count >= capacity) items.Remove(items.First().Key);
        var id = $"{prefix}-{Guid.NewGuid():N}";
        items.Add(id, (Stopwatch.GetTimestamp(), value));
        return id;
    }
    public T Get(string id)
    {
        if (!items.TryGetValue(id, out var item) || Stopwatch.GetElapsedTime(item.Time) >= ttl)
        {
            items.Remove(id);
            throw new DesktopException("STALE_REFERENCE", "Reference expired or was invalidated. List windows/observe/capture again.");
        }
        return item.Value;
    }
    public void Clear() => items.Clear();
}

internal readonly record struct PixelRect(int X, int Y, int Width, int Height)
{
    public bool Contains(int x, int y) => x >= X && y >= Y && x < (long)X + Width && y < (long)Y + Height;
}

internal static class InputCoordinates
{
    public static (int X, int Y) FromImage(double x, double y, int width, int height, PixelRect bounds)
    {
        if (!double.IsFinite(x) || !double.IsFinite(y) || x < 0 || y < 0 || x >= width || y >= height ||
            width != bounds.Width || height != bounds.Height)
            throw new DesktopException("INVALID_COORDINATES", "Coordinates must be inside the original, unscaled screenshot.");
        return (bounds.X + (int)Math.Floor(x), bounds.Y + (int)Math.Floor(y));
    }
    public static (int X, int Y) Normalize(int x, int y, PixelRect desktop)
    {
        if (desktop.Width < 2 || desktop.Height < 2 || !desktop.Contains(x, y))
            throw new DesktopException("INVALID_COORDINATES", "Point is outside the current virtual desktop.");
        return ((int)Math.Round((x - (double)desktop.X) * 65535 / (desktop.Width - 1)),
                (int)Math.Round((y - (double)desktop.Y) * 65535 / (desktop.Height - 1)));
    }
}
