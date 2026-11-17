using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace AgentBridgeLens.Windows;

internal static class Program
{
    private sealed record Request(string? Id, string Tool, JsonElement Parameters, WorkContext Context, CancellationTokenSource? Cancellation = null);
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    [MTAThread]
    private static void Main()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        using var requests = new BlockingCollection<Request>(33);
        var outputLock = new object();
        var cancellationLock = new object();
        var cancellation = new CancellationTokenSource();
        var active = new Dictionary<string, CancellationTokenSource>();
        int revokeRequested = 0;
        void Reply(string? id, object? result = null, Exception? error = null)
        {
            if (id == null) return;
            lock (outputLock)
            {
                var value = error == null ? (object)new { id, result } : new
                {
                    id, error = new { code = error is DesktopException desktop ? desktop.Code : error is COMException ? "UIA_ERROR" : "DESKTOP_ERROR",
                        message = error.Message }
                };
                Console.WriteLine(JsonSerializer.Serialize(value, JsonOptions));
            }
        }
        void LocalStop()
        {
            lock (cancellationLock)
            {
                cancellation.Cancel();
                cancellation = new();
                Interlocked.Exchange(ref revokeRequested, 1);
                if (!requests.IsAddingCompleted)
                    requests.TryAdd(new(null, "desktop_stop", JsonSerializer.SerializeToElement(new { }), new(cancellation.Token, TimeSpan.FromSeconds(30))));
            }
        }
        var reader = new Thread(() =>
        {
            try
            {
                while (ReadLine() is { } line)
                {
                    string? id = null;
                    try
                    {
                        using var document = JsonDocument.Parse(line);
                        var root = document.RootElement;
                        id = root.Required("id");
                        if (root.Text("type") == "cancel")
                        {
                            lock (cancellationLock)
                                if (active.TryGetValue(id, out var requestCancellation)) requestCancellation.Cancel();
                            continue;
                        }
                        var tool = root.Required("tool");
                        if (!root.TryGetProperty("params", out var parameters) || parameters.ValueKind != JsonValueKind.Object)
                            throw new DesktopException("INVALID_REQUEST", "params must be an object.");
                        lock (cancellationLock)
                        {
                            if (tool == "desktop_stop")
                            {
                                cancellation.Cancel(); cancellation = new();
                                Interlocked.Exchange(ref revokeRequested, 1);
                            }
                            var timeout = tool == "desktop_start_session" ? 110_000 : tool == "desktop_wait_for" ? parameters.Integer("timeoutMs", 10000, 1, 30000) : 30000;
                            if (active.ContainsKey(id)) throw new DesktopException("INVALID_REQUEST", "Duplicate in-flight request id.");
                            var requestSource = CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token);
                            active[id] = requestSource;
                            if (!requests.TryAdd(new(id, tool, parameters.Clone(), new(requestSource.Token, TimeSpan.FromMilliseconds(timeout)), requestSource)))
                            {
                                active.Remove(id); requestSource.Dispose();
                                throw new DesktopException("QUEUE_FULL", "Desktop request queue is full.");
                            }
                        }
                    }
                    catch (Exception error) { Reply(id, error: error); }
                }
            }
            catch (Exception error) { Console.Error.WriteLine(error.Message); }
            finally
            {
                lock (cancellationLock) { cancellation.Cancel(); requests.CompleteAdding(); }
            }
        }) { IsBackground = true, Name = "desktop-request-reader" };
        reader.Start();
        using var agent = new Agent(LocalStop);
        foreach (var request in requests.GetConsumingEnumerable())
        {
            try
            {
                // Revocation is independent of queue capacity and of a stop request's
                // cancelled token. Repeated local stops cannot accidentally retain permission.
                if (Interlocked.Exchange(ref revokeRequested, 0) != 0)
                    agent.Dispatch("desktop_stop", default, new(CancellationToken.None, TimeSpan.FromSeconds(5)));
                request.Context.Check();
                Reply(request.Id, agent.Dispatch(request.Tool, request.Parameters, request.Context));
            }
            catch (Exception error) { Reply(request.Id, error: error); }
            finally
            {
                lock (cancellationLock)
                {
                    if (request.Id != null) active.Remove(request.Id);
                    request.Cancellation?.Dispose();
                }
            }
        }
    }
    private static string? ReadLine()
    {
        var buffer = new StringBuilder();
        while (true)
        {
            int value = Console.In.Read();
            if (value < 0) return buffer.Length == 0 ? null : throw new DesktopException("INVALID_REQUEST", "Request must end with newline.");
            if (value == '\n') return buffer.ToString();
            if (buffer.Length >= 1024 * 1024) throw new DesktopException("INVALID_REQUEST", "Request exceeds 1 MiB characters.");
            buffer.Append((char)value);
        }
    }
}
