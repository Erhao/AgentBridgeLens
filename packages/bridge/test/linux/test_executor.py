import pathlib
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "linux-agent"))
from common import Context, DesktopError, References
from main import Agent
from portal import Portal, pixel_to_logical


class ReferencesTest(unittest.TestCase):
    def test_expiry_capacity_and_invalidation(self):
        store = References(ttl=30, capacity=2)
        with patch("common.time.monotonic", return_value=100):
            first = store.put("first", "r")
            second = store.put("second", "r")
            third = store.put("third", "r")
            with self.assertRaises(DesktopError):
                store.get(first)
            self.assertEqual(store.get(second), "second")
        with patch("common.time.monotonic", return_value=130):
            with self.assertRaises(DesktopError):
                store.get(third)
        store.clear()
        self.assertFalse(store.items)


class InputTest(unittest.TestCase):
    def portal(self):
        portal = Portal()
        portal.session = "/test/session"
        portal.devices = 3
        portal.revoked.clear()
        portal.call = lambda *_args, **_kwargs: None
        frame = {"portalSession": portal.session, "streamId": 7, "width": 2560, "height": 1440,
                 "logicalSize": [1280, 720]}
        key = portal.frames.put(frame, "screenshot")
        return portal, frame, key

    def test_fractional_scaling_and_unknown_geometry(self):
        _, frame, _ = self.portal()
        self.assertEqual(pixel_to_logical(frame, 1280, 720), (640, 360))
        for point in [(-1, 0), (2560, 0), (0, 1440), (float("nan"), 0), (True, 0)]:
            with self.subTest(point=point), self.assertRaises(DesktopError):
                pixel_to_logical(frame, *point)
        with self.assertRaises(DesktopError) as caught:
            pixel_to_logical({**frame, "logicalSize": None}, 0, 0)
        self.assertEqual(caught.exception.code, "UNSUPPORTED_COORDINATES")

    def test_cancel_releases_all_pressed_keys_in_reverse_order(self):
        portal, _, screenshot = self.portal()
        context, events = Context(), []

        def notify(method, signature, values):
            events.append((method, values))
            if values == (31, 1):
                context.cancel.set()

        portal.notify = notify
        with self.assertRaises(DesktopError) as caught:
            portal.act({"action": "press_keys", "keys": [29, 31], "screenshotId": screenshot}, context)
        self.assertEqual(caught.exception.code, "CANCELLED")
        self.assertEqual([values for _, values in events], [(29, 1), (31, 1), (31, 0), (29, 0)])

    def test_failed_release_closes_session_and_continues_releasing_other_keys(self):
        portal, _, screenshot = self.portal()
        events = []

        def notify(method, signature, values):
            events.append(values)
            if values == (31, 0):
                raise OSError("connection lost")

        portal.notify = notify
        with self.assertRaises(DesktopError) as caught:
            portal.act({"action": "press_keys", "keys": [29, 31], "screenshotId": screenshot}, Context())
        self.assertEqual(caught.exception.code, "INPUT_RELEASE_FAILED")
        self.assertEqual(events[-1], (29, 0))
        self.assertIsNone(portal.session)

    def test_expired_or_wrong_session_frame_never_sends_input(self):
        portal, _, screenshot = self.portal()
        events = []
        portal.notify = lambda *args: events.append(args)
        portal.session = "/new/session"
        with self.assertRaises(DesktopError):
            portal.act({"action": "click", "screenshotId": screenshot, "x": 10, "y": 10}, Context())
        self.assertEqual(events, [])

    def test_click_uses_stream_local_logical_coordinates_and_invalidates_frame(self):
        portal, _, screenshot = self.portal()
        events = []
        portal.notify = lambda method, signature, values: events.append((method, values))
        result = portal.act({"action": "click", "screenshotId": screenshot, "x": 1280, "y": 720}, Context())
        self.assertEqual(events[0], ("NotifyPointerMotionAbsolute", (7, 640, 360)))
        self.assertEqual(events[1:], [("NotifyPointerButton", (272, 1)), ("NotifyPointerButton", (272, 0))])
        self.assertTrue(result["accepted"])
        self.assertFalse(result["verified"])
        with self.assertRaises(DesktopError):
            portal.frames.get(screenshot)


class DispatchTest(unittest.TestCase):
    def test_stale_session_is_rejected_before_native_work(self):
        agent = Agent()
        with self.assertRaises(DesktopError) as caught:
            agent.dispatch("desktop_list_apps", {"sessionId": "previous-process"}, Context())
        self.assertEqual(caught.exception.code, "STALE_SESSION")

    def test_uncertain_action_invalidates_both_observation_types(self):
        agent = Agent()
        agent.a11y.snapshots.put("nodes", "snapshot")
        agent.portal.frames.put("frame", "frame")

        def uncertain(*_):
            raise OSError("application disappeared after accepting action")

        agent.a11y.act = uncertain
        with self.assertRaises(OSError):
            agent.dispatch("desktop_act", {"sessionId": agent.session_id, "action": "invoke"}, Context())
        self.assertFalse(agent.a11y.snapshots.items)
        self.assertFalse(agent.portal.frames.items)


if __name__ == "__main__":
    unittest.main()
