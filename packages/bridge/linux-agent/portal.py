"""XDG Portal sessions, PipeWire PNG capture and Notify input.

First release deliberately uses the documented Notify backend, never EIS and
Notify together. All descriptors remain in this process, not in JSON messages.
"""
import base64
import os
import struct
import threading
import time

from common import DesktopError, References, binding, identifier, require_desktop

DEST = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
PREFIX = "org.freedesktop.portal."


def pixel_to_logical(frame, x, y):
    width, height = frame["width"], frame["height"]
    if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        raise DesktopError("INVALID_ARGUMENT", "Pointer actions require numeric image-pixel x and y")
    if not (0 <= x < width and 0 <= y < height):
        raise DesktopError("INVALID_ARGUMENT", "Point is outside the captured image")
    size = frame.get("logicalSize")
    if not size or len(size) != 2 or min(size) <= 0:
        raise DesktopError("UNSUPPORTED_COORDINATES", "Portal did not provide logical stream size. Coordinate input is unavailable; do not assume image pixels equal desktop coordinates.")
    return x * size[0] / width, y * size[1] / height


class Portal:
    def __init__(self):
        self.bus = None
        self.session = None
        self.subscription = None
        self.revoked = threading.Event()
        self.devices = 0
        self.streams = []
        self.pipelines = {}
        self.frames = References(ttl=30, capacity=8)

    def connect(self):
        require_desktop()
        if self.bus is None:
            self.Gio = binding("Gio", "2.0")
            self.GLib = binding("GLib", "2.0")
            address = self.Gio.dbus_address_get_for_bus_sync(self.Gio.BusType.SESSION, None)
            self.bus = self.Gio.DBusConnection.new_for_address_sync(address,
                self.Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | self.Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                None, None)
        return self.bus

    def call(self, interface, method, signature, values, timeout=5000, path=PATH):
        self.connect()
        return self.bus.call_sync(DEST, path, PREFIX + interface, method,
                                  self.GLib.Variant(signature, values), None,
                                  self.Gio.DBusCallFlags.NONE, timeout, None)

    def properties(self, interface):
        self.connect()
        response = self.bus.call_sync(DEST, PATH, "org.freedesktop.DBus.Properties", "GetAll",
                                     self.GLib.Variant("(s)", (PREFIX + interface,)), None,
                                     self.Gio.DBusCallFlags.NONE, 2000, None)
        return response.unpack()[0]

    def capabilities(self):
        result = {"screenCast": False, "remoteDesktop": False, "active": bool(self.session and not self.revoked.is_set()),
                  "grantedDevices": self.devices if not self.revoked.is_set() else 0,
                  "inputBackend": "portal-notify", "persistence": False}
        if not self.session or self.revoked.is_set():
            result["streams"] = []
        else:
            result["streams"] = self.streams
        if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
            return result
        for interface, key in [("ScreenCast", "screenCast"), ("RemoteDesktop", "remoteDesktop")]:
            try:
                props = self.properties(interface)
                result[key] = bool(props.get("version"))
                result[key + "Version"] = props.get("version", 0)
                if interface == "RemoteDesktop":
                    result["availableDevices"] = props.get("AvailableDeviceTypes", 0)
            except Exception as error:
                result[key + "Error"] = str(error)
        return result

    def request(self, interface, method, signature, values, options, ctx):
        """Subscribe before calling so a quick Response cannot be missed."""
        self.connect()
        token = identifier("r").replace("-", "_")
        sender = self.bus.get_unique_name().lstrip(":").replace(".", "_")
        expected = PATH + "/request/" + sender + "/" + token
        completed, response = threading.Event(), []

        def received(_bus, _sender, _path, _iface, _signal, parameters):
            response.append(parameters.unpack())
            completed.set()

        subscription = self.bus.signal_subscribe(DEST, PREFIX + "Request", "Response", expected,
                                                 None, self.Gio.DBusSignalFlags.NONE, received)
        request_path = expected
        try:
            ctx.check()
            opts = {**options, "handle_token": self.GLib.Variant("s", token)}
            reply = self.call(interface, method, signature, (*values, opts))
            request_path = reply.unpack()[0]
            if request_path != expected:
                raise DesktopError("PORTAL_PROTOCOL", "Portal returned an unexpected request handle")
            while not completed.wait(0.05):
                ctx.check()
            ctx.check()
            code, results = response[0]
            if code:
                raise DesktopError("PERMISSION_DENIED" if code == 1 else "PORTAL_FAILED",
                                   "Desktop Portal request was cancelled or denied" if code == 1 else "Desktop Portal request failed")
            return results
        except Exception:
            try:
                self.call("Request", "Close", "()", (), timeout=1000, path=request_path)
            except Exception:
                pass
            raise
        finally:
            self.bus.signal_unsubscribe(subscription)

    def start(self, params, ctx):
        self.connect()
        self.close()
        # Check capture dependencies before showing a consent dialog.
        Gst = binding("Gst", "1.0")
        Gst.init(None)
        for plugin in ["pipewiresrc", "videoconvert", "videorate", "pngenc", "appsink"]:
            if not Gst.ElementFactory.find(plugin):
                raise DesktopError("MISSING_DEPENDENCY", "Missing GStreamer plugin: " + plugin)
        screen = self.properties("ScreenCast")
        if not screen.get("AvailableSourceTypes", 0) & 1:
            raise DesktopError("UNSUPPORTED", "Portal backend does not support monitor capture")
        use_input = params.get("input", False)
        if use_input:
            remote = self.properties("RemoteDesktop")
            if remote.get("AvailableDeviceTypes", 0) & 3 != 3:
                raise DesktopError("UNSUPPORTED", "Portal backend does not offer both keyboard and pointer")
        owner = "RemoteDesktop" if use_input else "ScreenCast"
        # Callbacks queued for an old connection cannot revoke a new session.
        self.revoked = threading.Event()
        session_revoked = self.revoked
        try:
            created = self.request(owner, "CreateSession", "(a{sv})", (), {
                "session_handle_token": self.GLib.Variant("s", identifier("s").replace("-", "_")),
            }, ctx)
            self.session = created["session_handle"]
            self.subscription = self.bus.signal_subscribe(DEST, PREFIX + "Session", "Closed", self.session,
                None, self.Gio.DBusSignalFlags.NONE, lambda *_: session_revoked.set())
            if use_input:
                self.request(owner, "SelectDevices", "(oa{sv})", (self.session,), {
                    "types": self.GLib.Variant("u", 3),
                }, ctx)
            sources = {"types": self.GLib.Variant("u", 1),
                       "multiple": self.GLib.Variant("b", params.get("multiple", False))}
            if screen.get("AvailableCursorModes", 0) & 2:
                sources["cursor_mode"] = self.GLib.Variant("u", 2)
            self.request("ScreenCast", "SelectSources", "(oa{sv})", (self.session,), sources, ctx)
            result = self.request(owner, "Start", "(osa{sv})", (self.session, ""), {}, ctx)
            ctx.check()
            if self.revoked.is_set():
                raise DesktopError("SESSION_CLOSED", "Desktop sharing session was closed")
            self.devices = result.get("devices", 0) if use_input else 0
            streams = result.get("streams", [])
            if not streams or len(streams) > 16:
                raise DesktopError("PORTAL_FAILED", "Portal returned no streams or too many streams")
            self.streams = [{"streamId": node, "position": props.get("position"),
                             "logicalSize": props.get("logical_size", props.get("size")),
                             "sourceType": props.get("source_type"),
                             "pipewireSerial": props.get("pipewire-serial")}
                            for node, props in streams]
            return {"active": True, "grantedDevices": self.devices, "streams": self.streams,
                    "inputBackend": "portal-notify" if use_input else None, "persistence": False}
        except Exception:
            self.close()
            raise

    def require_session(self, device=0):
        if not self.session or self.revoked.is_set():
            self.close()
            raise DesktopError("SESSION_CLOSED", "No active sharing session. Call desktop_start_session and obtain local consent.")
        if device and not self.devices & device:
            raise DesktopError("PERMISSION_DENIED", "Required input device was not granted by the Portal")

    def pipeline(self, stream):
        node = stream["streamId"]
        if node in self.pipelines:
            return self.pipelines[node][0], self.pipelines[node][1]
        self.connect()
        response, fds = self.bus.call_with_unix_fd_list_sync(DEST, PATH, PREFIX + "ScreenCast", "OpenPipeWireRemote",
            self.GLib.Variant("(oa{sv})", (self.session, {})), None, self.Gio.DBusCallFlags.NONE, 5000, None, None)
        fd = fds.get(response.unpack()[0])
        Gst = binding("Gst", "1.0")
        pipeline = None
        try:
            # Fixed pipeline string: no shell and no user-provided pipeline code.
            pipeline = Gst.parse_launch("pipewiresrc name=source ! videoconvert ! videorate drop-only=true ! "
                                        "video/x-raw,framerate=2/1 ! pngenc ! appsink name=sink max-buffers=1 drop=true sync=false")
            source = pipeline.get_by_name("source")
            source.set_property("fd", fd)
            serial = stream.get("pipewireSerial")
            if serial is not None and source.find_property("target-object"):
                source.set_property("target-object", str(serial))
            else:
                source.set_property("path", str(node))
            if source.find_property("keepalive-time"):
                source.set_property("keepalive-time", 1000)
            sink = pipeline.get_by_name("sink")
            if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                raise DesktopError("CAPTURE_FAILED", "GStreamer could not start PipeWire capture")
            # pipewiresrc duplicates the supplied fd; we retain/close our copy.
            self.pipelines[node] = (pipeline, sink, fd)
            return pipeline, sink
        except Exception:
            if pipeline:
                pipeline.set_state(Gst.State.NULL)
            os.close(fd)
            raise

    def capture(self, params, ctx):
        self.require_session()
        stream_id = params.get("streamId")
        if stream_id is None and len(self.streams) != 1:
            raise DesktopError("INVALID_ARGUMENT", "Choose streamId when sharing multiple sources")
        stream = next((item for item in self.streams if stream_id is None or item["streamId"] == stream_id), None)
        if stream is None:
            raise DesktopError("INVALID_ARGUMENT", "Unknown streamId")
        pipeline, sink = self.pipeline(stream)
        Gst = binding("Gst", "1.0")
        until = time.monotonic() + 8
        sample = None
        while sample is None:
            ctx.check()
            self.require_session()
            sample = sink.emit("try-pull-sample", 100 * Gst.MSECOND)
            error = pipeline.get_bus().pop_filtered(Gst.MessageType.ERROR)
            if error:
                # Native error details are diagnostic, not screenshot contents.
                raise DesktopError("CAPTURE_FAILED", "PipeWire/GStreamer capture failed: " + error.parse_error()[0].message)
            if time.monotonic() >= until:
                raise DesktopError("CAPTURE_TIMEOUT", "No PipeWire frame arrived within 8 seconds")
        buffer = sample.get_buffer()
        if buffer.get_size() > 16 * 1024 * 1024:
            raise DesktopError("CAPTURE_TOO_LARGE", "PNG exceeds 16 MiB")
        data = buffer.extract_dup(0, buffer.get_size())
        if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
            raise DesktopError("CAPTURE_FAILED", "Capture did not return a valid PNG")
        width, height = struct.unpack(">II", data[16:24])
        metadata = {"streamId": stream["streamId"], "width": width, "height": height,
                    "logicalSize": stream["logicalSize"], "position": stream["position"],
                    "capturedAt": time.time(), "expiresInMs": 30_000,
                    "coordinateSpace": "image-pixels", "portalSession": self.session}
        screenshot_id = self.frames.put(metadata, "screenshot")
        return {"screenshot": {**metadata, "screenshotId": screenshot_id,
                               "mimeType": "image/png", "data": base64.b64encode(data).decode("ascii")}}

    def notify(self, method, signature, values):
        self.call("RemoteDesktop", method, signature, (self.session, {}, *values), timeout=2000)

    def act(self, params, ctx):
        action = params["action"]
        device = 1 if action == "press_keys" else 2
        self.require_session(device)
        frame = self.frames.get(params.get("screenshotId"))
        if frame["portalSession"] != self.session:
            raise DesktopError("STALE_REFERENCE", "Screenshot belongs to a different sharing session")
        ctx.check()
        if action in ("click", "move", "scroll"):
            x, y = pixel_to_logical(frame, params.get("x"), params.get("y"))
            self.notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)", (frame["streamId"], x, y))
        if action == "click":
            button = {"left": 272, "middle": 274, "right": 273}.get(params.get("button", "left"))
            if button is None:
                raise DesktopError("INVALID_ARGUMENT", "Unknown pointer button")
            # Always attempt release, even when cancellation arrives mid-click.
            try:
                ctx.check()
                self.notify("NotifyPointerButton", "(oa{sv}iu)", (button, 1))
                ctx.pause(0.04)
            finally:
                try:
                    self.notify("NotifyPointerButton", "(oa{sv}iu)", (button, 0))
                except Exception as error:
                    self.close()
                    raise DesktopError("INPUT_RELEASE_FAILED", "Button release failed; sharing session closed") from error
        elif action == "scroll":
            dx, dy = params.get("dx", 0), params.get("dy", 0)
            if not dx and not dy:
                raise DesktopError("INVALID_ARGUMENT", "scroll requires nonzero dx or dy")
            ctx.check()
            self.notify("NotifyPointerAxis", "(oa{sv}dd)", (dx, dy))
        elif action == "press_keys":
            keys = params.get("keys")
            if not isinstance(keys, list) or not 1 <= len(keys) <= 8 or len(set(keys)) != len(keys) or any(type(key) is not int or not 1 <= key <= 767 for key in keys):
                raise DesktopError("INVALID_ARGUMENT", "keys must contain 1..8 distinct Linux evdev keycodes (1..767)")
            pressed = []
            release_error = None
            try:
                for key in keys:
                    ctx.check()
                    pressed.append(key)  # Release even if a timed-out press was delivered.
                    self.notify("NotifyKeyboardKeycode", "(oa{sv}iu)", (key, 1))
                ctx.pause(0.04)
            finally:
                for key in reversed(pressed):
                    try:
                        self.notify("NotifyKeyboardKeycode", "(oa{sv}iu)", (key, 0))
                    except Exception as error:
                        release_error = error
                if release_error:
                    self.close()
                    raise DesktopError("INPUT_RELEASE_FAILED", "Key release failed; sharing session closed") from release_error
        elif action != "move":
            raise DesktopError("UNSUPPORTED_ACTION", "Unknown input action")
        self.frames.clear()
        ctx.check()
        return {"accepted": True, "verified": False, "action": action,
                "verification": "Input was sent. Capture/observe again to verify the outcome."}

    def close(self):
        self.frames.clear()
        self.revoked.set()
        for pipeline, _sink, fd in self.pipelines.values():
            try:
                pipeline.set_state(binding("Gst", "1.0").State.NULL)
            except Exception:
                pass
            finally:
                try:
                    os.close(fd)
                except OSError:
                    pass
        self.pipelines.clear()
        if self.subscription is not None:
            self.bus.signal_unsubscribe(self.subscription)
            self.subscription = None
        if self.session:
            try:
                self.call("Session", "Close", "()", (), timeout=1000, path=self.session)
            except Exception:
                pass
        self.session, self.streams, self.devices = None, [], 0
        # Private connection: dropping it also ends any Portal session whose
        # explicit Close failed, without closing AT-SPI's bus connection.
        if self.bus is not None:
            try:
                self.bus.close_sync(None)
            except Exception:
                pass
            self.bus = None
