using AgentBridgeLens.Windows;

int passed = 0;
void Check(bool value, string message) { if (!value) throw new Exception(message); passed++; }
void Error(string code, Action action)
{
    try { action(); throw new Exception($"Expected {code}"); }
    catch (DesktopException error) { Check(error.Code == code, $"Expected {code}, got {error.Code}"); }
}

// Screenshot coordinates remain physical pixels, including a monitor left of the primary one.
var bounds = new PixelRect(-1600, 100, 1200, 800);
Check(InputCoordinates.FromImage(100.9, 50.9, 1200, 800, bounds) == (-1500, 150), "Secondary monitor offset");
Error("INVALID_COORDINATES", () => InputCoordinates.FromImage(1200, 0, 1200, 800, bounds));
Error("INVALID_COORDINATES", () => InputCoordinates.FromImage(-1, 0, 1200, 800, bounds));
Error("INVALID_COORDINATES", () => InputCoordinates.FromImage(double.NaN, 0, 1200, 800, bounds));
Error("INVALID_COORDINATES", () => InputCoordinates.FromImage(100, 20, 600, 400, bounds));
var desktop = new PixelRect(-1920, -200, 5760, 2360);
Check(InputCoordinates.Normalize(-1920, -200, desktop) == (0, 0), "Virtual desktop top left");
Check(InputCoordinates.Normalize(3839, 2159, desktop) == (65535, 65535), "Virtual desktop bottom right");
Error("INVALID_COORDINATES", () => InputCoordinates.Normalize(3840, 0, desktop));

var refs = new References<string>(TimeSpan.FromMinutes(1), 2);
var a = refs.Put("a", "node"); var b = refs.Put("b", "node"); var c = refs.Put("c", "node");
Error("STALE_REFERENCE", () => refs.Get(a));
Check(refs.Get(b) == "b" && refs.Get(c) == "c", "Bounded live references");
refs.Clear(); Error("STALE_REFERENCE", () => refs.Get(c));
var expired = new References<string>(TimeSpan.Zero, 1);
Error("STALE_REFERENCE", () => expired.Get(expired.Put("old", "node")));

using var cancellation = new CancellationTokenSource();
var context = new WorkContext(cancellation.Token, TimeSpan.FromMinutes(1));
cancellation.Cancel(); Error("CANCELLED", () => context.Pause(10000));
Error("TIMEOUT", () => new WorkContext(CancellationToken.None, TimeSpan.Zero).Check());

Check(KeyboardNames.Chord(["ctrl", "S"]).SequenceEqual(new ushort[] { 0x11, 0x53 }), "Named keys");
Check(KeyboardNames.Parse("F24") == 0x87 && KeyboardNames.Parse("ENTER") == 0x0D, "Function and control keys");
foreach (var names in new[] { new[] { "CTRL", "CTRL" }, new[] { "WIN", "R" }, new[] { "ALT", "TAB" }, new[] { "CTRL", "SHIFT", "ESC" }, new[] { "CTRL", "ALT", "DELETE" } })
    Error("INVALID_KEY", () => KeyboardNames.Chord(names));
Error("INVALID_KEY", () => KeyboardNames.Parse("29"));
Error("INVALID_KEY", () => KeyboardNames.Chord([]));
Console.WriteLine($"{passed} core assertions passed (coordinates, references, cancellation, keyboard scope).");
