import os
import json
import pathlib
import queue
import select
import subprocess
import sys
import threading
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "linux-agent"))
from common import Context, DesktopError
from main import Agent


@unittest.skipUnless(os.environ.get("ABL_DESKTOP_INTEGRATION") == "1", "Run explicitly under isolated Xvfb and dbus-run-session")
class AccessibilityIntegration(unittest.TestCase):
    def test_json_protocol_serializes_work_and_stop_cancels_active_and_queued_requests(self):
        # Own the Portal name before capabilities probes, keeping this test bus
        # independent of any installed desktop Portal services.
        from test_portal_integration import FakePortal
        service = FakePortal()
        self.addCleanup(service.close)
        fixture = subprocess.Popen(["/usr/bin/python3", str(pathlib.Path(__file__).with_name("gtk_fixture.py"))],
            stdout=subprocess.PIPE, env={**os.environ, "GTK_MODULES": "atk-bridge", "NO_AT_BRIDGE": "0"})
        worker = subprocess.Popen(["/usr/bin/python3", "-u", str(pathlib.Path(__file__).resolve().parents[2] / "linux-agent" / "main.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

        def cleanup():
            for child in [worker, fixture]:
                if child.poll() is None:
                    child.terminate()
                child.wait(timeout=5)
                if child.stdin:
                    child.stdin.close()
                child.stdout.close()

        self.addCleanup(cleanup)
        self.assertTrue(select.select([fixture.stdout], [], [], 10)[0])
        self.assertEqual(fixture.stdout.readline().strip(), b"ready")
        replies = queue.Queue()

        def receive():
            for line in worker.stdout:
                replies.put(json.loads(line))

        threading.Thread(target=receive, daemon=True).start()

        def send(request_id, tool, params):
            worker.stdin.write(json.dumps({"id": request_id, "tool": tool, "params": params}) + "\n")
            worker.stdin.flush()

        send("caps", "desktop_get_capabilities", {})
        caps = replies.get(timeout=10)["result"]
        session = {"sessionId": caps["sessionId"]}
        windows = []
        for _ in range(30):
            send("windows", "desktop_list_windows", session)
            windows = replies.get(timeout=5)["result"]["windows"]
            if windows:
                break
            time.sleep(0.1)
        window = next(item for item in windows if item["name"] == "AgentBridgeLens desktop integration")
        args = {**session, "windowId": window["windowId"]}
        send("wait", "desktop_wait_for", {**args, "name": "This label will never exist", "timeoutMs": 30_000})
        send("queued", "desktop_observe", args)
        time.sleep(0.1)
        send("stop", "desktop_stop", {})
        results = {response["id"]: response for response in [replies.get(timeout=5) for _ in range(3)]}
        self.assertEqual(results["wait"]["error"]["code"], "CANCELLED")
        self.assertEqual(results["queued"]["error"]["code"], "CANCELLED")
        self.assertTrue(results["stop"]["result"]["sharingClosed"])
        send("old", "desktop_observe", args)
        self.assertEqual(replies.get(timeout=5)["error"]["code"], "STALE_REFERENCE")
        worker.stdin.close()
        self.assertEqual(worker.wait(timeout=5), 0)

    def test_real_gtk_observe_unicode_write_invoke_and_password_redaction(self):
        child = subprocess.Popen(["/usr/bin/python3", str(pathlib.Path(__file__).with_name("gtk_fixture.py"))],
                                 stdout=subprocess.PIPE, env={**os.environ, "GTK_MODULES": "atk-bridge", "NO_AT_BRIDGE": "0"})
        def cleanup():
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            child.stdout.close()
        self.addCleanup(cleanup)
        self.assertTrue(select.select([child.stdout], [], [], 10)[0], "GTK fixture did not start")
        self.assertEqual(child.stdout.readline().strip(), b"ready")
        agent = Agent()
        self.addCleanup(agent.portal.close)
        window = None
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            windows = agent.a11y.list_windows({}, Context())["windows"]
            window = next((item for item in windows if item["name"] == "AgentBridgeLens desktop integration"), None)
            if window:
                break
            time.sleep(0.1)
        self.assertIsNotNone(window, "AT-SPI did not discover the GTK window")
        args = {"sessionId": agent.session_id, "windowId": window["windowId"], "includeText": True}
        snapshot = agent.dispatch("desktop_observe", args, Context())
        nodes = snapshot["nodes"]
        self.assertNotIn("secret-value-must-not-appear", str(snapshot))
        self.assertTrue(next(node for node in nodes if node["name"] == "Password")["protected"])
        entry = next(node for node in nodes if node["name"] == "Message")
        result = agent.dispatch("desktop_act", {"sessionId": agent.session_id, "snapshotId": snapshot["snapshotId"],
            "target": entry["id"], "action": "set_text", "text": "你好 Ubuntu 👋\n第二行"}, Context())
        self.assertTrue(result["accepted"])
        self.assertTrue(result["verified"])
        with self.assertRaises(DesktopError):
            agent.a11y.snapshots.get(snapshot["snapshotId"])
        snapshot = agent.dispatch("desktop_observe", args, Context())
        button = next(node for node in snapshot["nodes"] if node["name"] == "Apply" and node.get("actions"))
        result = agent.dispatch("desktop_act", {"sessionId": agent.session_id, "snapshotId": snapshot["snapshotId"],
            "target": button["id"], "action": "invoke", "actionName": button["actions"][0]}, Context())
        self.assertTrue(result["accepted"])
        self.assertFalse(result["verified"], "Action acceptance does not establish business outcome")
        result = agent.dispatch("desktop_wait_for", {**args, "name": "Applied: 你好 Ubuntu 👋\n第二行"}, Context(timeout=5))
        self.assertTrue(result["matches"])
        # Stop invalidates window IDs, not just node references.
        agent.dispatch("desktop_stop", {}, Context())
        with self.assertRaises(DesktopError):
            agent.dispatch("desktop_observe", args, Context())
        child.terminate()
        child.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
