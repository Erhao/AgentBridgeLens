"""Real D-Bus transport and GStreamer, with an isolated fake Portal backend.

This checks wire signatures, early Response signals, cancellation and revocation;
it does not substitute for testing GNOME's actual consent dialog/PipeWire server.
"""
import base64
import os
import pathlib
import sys
import threading
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "linux-agent"))
from common import Context, DesktopError, binding
from portal import DEST, PATH, PREFIX, Portal


XML = """<node>
<interface name="org.freedesktop.portal.RemoteDesktop">
  <property name="version" type="u" access="read"/>
  <property name="AvailableDeviceTypes" type="u" access="read"/>
  <method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
  <method name="SelectDevices"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
  <method name="Start"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
  <method name="NotifyPointerMotionAbsolute"><arg type="o"/><arg type="a{sv}"/><arg type="u"/><arg type="d"/><arg type="d"/></method>
  <method name="NotifyPointerButton"><arg type="o"/><arg type="a{sv}"/><arg type="i"/><arg type="u"/></method>
  <method name="NotifyPointerAxis"><arg type="o"/><arg type="a{sv}"/><arg type="d"/><arg type="d"/></method>
  <method name="NotifyKeyboardKeycode"><arg type="o"/><arg type="a{sv}"/><arg type="i"/><arg type="u"/></method>
</interface>
<interface name="org.freedesktop.portal.ScreenCast">
  <property name="version" type="u" access="read"/>
  <property name="AvailableSourceTypes" type="u" access="read"/>
  <property name="AvailableCursorModes" type="u" access="read"/>
  <method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
  <method name="SelectSources"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
  <method name="Start"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
</interface>
<interface name="org.freedesktop.portal.Request">
  <method name="Close"/>
  <signal name="Response"><arg type="u"/><arg type="a{sv}"/></signal>
</interface>
<interface name="org.freedesktop.portal.Session">
  <method name="Close"/>
  <signal name="Closed"><arg type="a{sv}"/></signal>
</interface>
</node>"""


class FakePortal:
    def __init__(self):
        self.Gio = binding("Gio", "2.0")
        self.GLib = binding("GLib", "2.0")
        self.bus = self.Gio.bus_get_sync(self.Gio.BusType.SESSION, None)
        self.interfaces = self.Gio.DBusNodeInfo.new_for_xml(XML).interfaces
        self.registrations = []
        self.events = []
        self.deny = False
        self.pending_start = False
        self.started = threading.Event()
        self.session = None
        self.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
                           self.GLib.Variant("(su)", (DEST, 0)), None, self.Gio.DBusCallFlags.NONE, 1000, None)
        for info in self.interfaces[:2]:
            self.registrations.append(self.bus.register_object(PATH, info, self.method, self.property, None))

    def property(self, _bus, _sender, _path, interface, name):
        values = {"version": 2 if interface.endswith("RemoteDesktop") else 5,
                  "AvailableDeviceTypes": 3, "AvailableSourceTypes": 1, "AvailableCursorModes": 3}
        return self.GLib.Variant("u", values[name])

    def register(self, path, interface):
        info = next(item for item in self.interfaces if item.name == PREFIX + interface)
        self.registrations.append(self.bus.register_object(path, info, self.method, None, None))

    def method(self, _bus, sender, path, interface, method, parameters, invocation):
        values = parameters.unpack()
        self.events.append((interface, method, values))
        if method == "Close" or method.startswith("Notify"):
            invocation.return_value(None)
            return
        options = values[-1]
        sender_id = sender.lstrip(":").replace(".", "_")
        request_path = PATH + "/request/" + sender_id + "/" + options["handle_token"]
        self.register(request_path, "Request")
        results = {}
        if method == "CreateSession":
            self.session = PATH + "/session/" + sender_id + "/" + options["session_handle_token"]
            self.register(self.session, "Session")
            results["session_handle"] = self.GLib.Variant("o", self.session)
        elif method == "Start":
            results = {"devices": self.GLib.Variant("u", 3),
                       "streams": self.GLib.Variant("a(ua{sv})", [(42, {
                           "size": self.GLib.Variant("(ii)", (640, 360)),
                           "position": self.GLib.Variant("(ii)", (1280, 0)),
                           "source_type": self.GLib.Variant("u", 1)})])}
            self.started.set()
        if not (method == "Start" and self.pending_start):
            # Intentionally emit before method return, exercising the race.
            self.bus.emit_signal(sender, request_path, PREFIX + "Request", "Response",
                                 self.GLib.Variant("(ua{sv})", (1 if self.deny and method == "Start" else 0, results)))
        invocation.return_value(self.GLib.Variant("(o)", (request_path,)))

    def revoke(self):
        self.bus.emit_signal(None, self.session, PREFIX + "Session", "Closed", self.GLib.Variant("(a{sv})", ({},)))
        self.bus.flush_sync(None)

    def close(self):
        for registration in self.registrations:
            self.bus.unregister_object(registration)
        self.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ReleaseName",
                           self.GLib.Variant("(s)", (DEST,)), None, self.Gio.DBusCallFlags.NONE, 1000, None)


@unittest.skipUnless(os.environ.get("ABL_DESKTOP_INTEGRATION") == "1", "Requires an isolated D-Bus session")
class PortalIntegration(unittest.TestCase):
    def test_consent_capture_notify_revocation_denial_and_cancellation(self):
        service = FakePortal()
        self.addCleanup(service.close)
        portal = Portal()
        self.addCleanup(portal.close)
        caps = portal.capabilities()
        self.assertTrue(caps["screenCast"])
        self.assertFalse(caps["active"])
        self.assertFalse(any(method == "Start" for _, method, _ in service.events))
        shared = portal.start({"input": True}, Context(timeout=10))
        self.assertEqual(shared["grantedDevices"], 3)
        self.assertEqual(shared["streams"][0]["logicalSize"], (640, 360))

        Gst = binding("Gst", "1.0")
        pipeline = Gst.parse_launch("videotestsrc is-live=true ! video/x-raw,width=1280,height=720,framerate=2/1 ! "
                                    "videoconvert ! pngenc ! appsink name=sink max-buffers=1 drop=true sync=false")
        self.addCleanup(lambda: pipeline.set_state(Gst.State.NULL))
        pipeline.set_state(Gst.State.PLAYING)
        # Real encoder/appsink; substitute only the compositor's PipeWire source.
        portal.pipeline = lambda _stream: (pipeline, pipeline.get_by_name("sink"))
        frame = portal.capture({}, Context())["screenshot"]
        self.assertEqual((frame["width"], frame["height"]), (1280, 720))
        self.assertTrue(base64.b64decode(frame["data"]).startswith(b"\x89PNG"))
        portal.act({"action": "click", "screenshotId": frame["screenshotId"], "x": 640, "y": 360}, Context())
        motions = [values for _, method, values in service.events if method == "NotifyPointerMotionAbsolute"]
        self.assertEqual(motions[-1][-3:], (42, 320, 180))

        service.revoke()
        self.assertTrue(portal.revoked.wait(2))
        with self.assertRaises(DesktopError) as caught:
            portal.capture({}, Context())
        self.assertEqual(caught.exception.code, "SESSION_CLOSED")
        self.assertIsNone(portal.bus)

        service.deny = True
        with self.assertRaises(DesktopError) as caught:
            portal.start({}, Context(timeout=10))
        self.assertEqual(caught.exception.code, "PERMISSION_DENIED")
        self.assertIsNone(portal.session)

        service.deny = False
        service.pending_start = True
        service.started.clear()
        context = Context(timeout=10)

        def cancel_when_prompted():
            service.started.wait(5)
            context.cancel.set()

        thread = threading.Thread(target=cancel_when_prompted)
        thread.start()
        with self.assertRaises(DesktopError) as caught:
            portal.start({}, context)
        thread.join(timeout=5)
        self.assertEqual(caught.exception.code, "CANCELLED")
        self.assertIsNone(portal.session)
        self.assertTrue(any(interface.endswith("Request") and method == "Close" for interface, method, _ in service.events))


if __name__ == "__main__":
    unittest.main()
