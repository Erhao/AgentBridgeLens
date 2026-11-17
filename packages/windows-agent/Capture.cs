using System.Runtime.InteropServices;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using WinRT;

namespace AgentBridgeLens.Windows;

internal sealed record FrameRef(WindowRef Window, PixelRect Bounds, PixelRect Desktop, uint Dpi, int Width, int Height, bool InputMappingAvailable);

internal sealed class Capture : IDisposable
{
    private readonly References<FrameRef> frames = new(TimeSpan.FromSeconds(30), 8);
    private IDirect3DDevice? device;
    private GraphicsCaptureItem? item;
    public WindowRef? Target { get; private set; }
    public bool InputAllowed { get; private set; }
    public static bool Supported
    {
        get
        {
            try { return GraphicsCaptureSession.IsSupported(); }
            catch (Exception error) when (error is COMException or NotSupportedException) { return false; }
        }
    }

    public void Start(WindowRef window, bool input, WorkContext context)
    {
        Close();
        window.Check();
        Consent.Request(window, input, context);
        context.Check();
        Target = window;
        InputAllowed = input;
    }

    private void InitializeCapture(WindowRef window)
    {
        if (item != null) return;
        if (!Supported) throw new DesktopException("CAPTURE_UNAVAILABLE", "Windows Graphics Capture is unavailable; approved UIA actions can still be used.");
        nint pointer = 0;
        try
        {
            // CreateForWindow scopes the source to the locally approved HWND.
            var factory = GraphicsCaptureItem.As<IGraphicsCaptureItemInterop>();
            var iid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
            factory.CreateForWindow(window.Handle, ref iid, out pointer);
            item = MarshalInspectable<GraphicsCaptureItem>.FromAbi(pointer);
            device = CreateDevice();
        }
        catch { item = null; device?.Dispose(); device = null; throw; }
        finally { if (pointer != 0) Marshal.Release(pointer); }
    }

    public Dictionary<string, object?> Screenshot(WorkContext context)
    {
        var target = Target ?? throw new DesktopException("PERMISSION_REQUIRED", "Call desktop_start_session and approve a window first.");
        target.Check();
        if (Native.IsIconic(target.Handle)) throw new DesktopException("WINDOW_UNAVAILABLE", "Restore the minimized window before capturing.");
        InitializeCapture(target);
        var bounds = Native.Bounds(target.Handle);
        var desktop = Native.VirtualDesktop();
        var dpi = Native.GetDpiForWindow(target.Handle);
        var size = item!.Size;
        if (size.Width <= 0 || size.Height <= 0 || (long)size.Width * size.Height > 20_000_000)
            throw new DesktopException("CAPTURE_UNAVAILABLE", "Window is empty or exceeds the 20 megapixel capture limit.");
        using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device!, DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, size);
        using var captureSession = pool.CreateCaptureSession(item);
        // Keep the system capture border. Never request borderless access.
        captureSession.StartCapture();
        Direct3D11CaptureFrame? frame = null;
        try
        {
            while (frame == null)
            {
                context.Check();
                frame = pool.TryGetNextFrame();
                if (frame == null) context.Pause(20);
            }
            using var bitmap = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface).AsTask(context.Cancellation).GetAwaiter().GetResult();
            using var stream = new InMemoryRandomAccessStream();
            var encoder = BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream).AsTask(context.Cancellation).GetAwaiter().GetResult();
            encoder.SetSoftwareBitmap(bitmap);
            encoder.FlushAsync().AsTask(context.Cancellation).GetAwaiter().GetResult();
            if (stream.Size > 16 * 1024 * 1024) throw new DesktopException("CAPTURE_TOO_LARGE", "PNG exceeds 16 MiB. Reduce the target window size.");
            stream.Seek(0);
            using var reader = new DataReader(stream.GetInputStreamAt(0));
            reader.LoadAsync((uint)stream.Size).AsTask(context.Cancellation).GetAwaiter().GetResult();
            var bytes = new byte[(int)stream.Size];
            reader.ReadBytes(bytes);
            target.Check();
            context.Check();
            if (bounds != Native.Bounds(target.Handle) || desktop != Native.VirtualDesktop() || dpi != Native.GetDpiForWindow(target.Handle))
                throw new DesktopException("LAYOUT_CHANGED", "Window geometry or display layout changed during capture. Capture again.");
            var width = frame.ContentSize.Width;
            var height = frame.ContentSize.Height;
            // WGC surfaces can include padding. Refuse input unless all dimensions agree.
            bool mapped = width == bitmap.PixelWidth && height == bitmap.PixelHeight && width == bounds.Width && height == bounds.Height;
            var reference = new FrameRef(target, bounds, desktop, dpi, bitmap.PixelWidth, bitmap.PixelHeight, mapped);
            return new()
            {
                ["screenshot"] = new
                {
                    data = Convert.ToBase64String(bytes), mimeType = "image/png",
                    screenshotId = frames.Put(reference, "frame"), width = bitmap.PixelWidth, height = bitmap.PixelHeight,
                    coordinateSpace = "image-pixels", desktopBounds = bounds, dpi, inputMappingAvailable = mapped,
                    capturedAt = DateTimeOffset.UtcNow, expiresInMs = 30000
                }
            };
        }
        finally { frame?.Dispose(); }
    }
    public FrameRef Frame(string id)
    {
        var frame = frames.Get(id);
        RequireInput(frame.Window);
        if (frame.Bounds != Native.Bounds(frame.Window.Handle) || frame.Desktop != Native.VirtualDesktop() || frame.Dpi != Native.GetDpiForWindow(frame.Window.Handle))
            throw new DesktopException("LAYOUT_CHANGED", "Window moved/resized or display layout changed. Capture again.");
        if (Native.GetForegroundWindow() != frame.Window.Handle)
            throw new DesktopException("FOCUS_CHANGED", "Approved window must be foreground before sending input. Activate it and capture again.");
        if (!frame.InputMappingAvailable)
            throw new DesktopException("UNMAPPED_COORDINATES", "Capture dimensions do not match window bounds; coordinate input is unavailable.");
        return frame;
    }
    public void RequireInput(WindowRef window)
    {
        window.Check();
        if (!InputAllowed || Target != window)
            throw new DesktopException("PERMISSION_REQUIRED", "Approve this window with desktop_start_session(input:true) before any action.");
    }
    public void ClearFrames() => frames.Clear();
    public void Close()
    {
        frames.Clear();
        Target = null;
        InputAllowed = false;
        item = null;
        device?.Dispose();
        device = null;
    }
    public void Dispose() => Close();

    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        void CreateForWindow(nint window, ref Guid iid, out nint result);
        void CreateForMonitor(nint monitor, ref Guid iid, out nint result);
    }
    [DllImport("d3d11.dll", ExactSpelling = true)]
    private static extern int D3D11CreateDevice(nint adapter, int driverType, nint software, uint flags, nint levels, uint levelCount,
        uint sdkVersion, out nint device, out int featureLevel, out nint context);
    [DllImport("d3d11.dll", ExactSpelling = true)] private static extern int CreateDirect3D11DeviceFromDXGIDevice(nint dxgi, out nint device);
    private static IDirect3DDevice CreateDevice()
    {
        nint native = 0, immediate = 0, dxgi = 0, inspectable = 0;
        try
        {
            int hr = D3D11CreateDevice(0, 1, 0, 0x20, 0, 0, 7, out native, out _, out immediate);
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
            var iid = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(native, in iid, out dxgi));
            Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out inspectable));
            return MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
        }
        finally
        {
            foreach (var ptr in new[] { inspectable, dxgi, immediate, native }) if (ptr != 0) Marshal.Release(ptr);
        }
    }
}
