#!/usr/bin/env python3
"""Local JSON Lines executor. stdout is protocol-only; no network listener."""
import json
import os
import queue
import signal
import sys
import threading

from accessibility import Accessibility
from common import Context, DesktopError, binding, graphical_session, identifier
from portal import Portal


class Agent:
    def __init__(self):
        self.session_id = identifier("desktop")
        self.a11y = Accessibility()
        self.portal = Portal()

    def capabilities(self):
        dependencies = {}
        for name, version in [("Atspi", "2.0"), ("Gio", "2.0"), ("Gst", "1.0")]:
            try:
                api = binding(name, version)
                dependencies[name] = {"available": True}
                if name == "Gst":
                    api.init(None)
                    dependencies[name]["plugins"] = {plugin: bool(api.ElementFactory.find(plugin))
                        for plugin in ["pipewiresrc", "videoconvert", "videorate", "pngenc", "appsink"]}
            except DesktopError as error:
                dependencies[name] = {"available": False, "error": str(error)}
        return {"sessionId": self.session_id, "platform": sys.platform,
                "desktop": os.environ.get("XDG_CURRENT_DESKTOP"), "sessionType": os.environ.get("XDG_SESSION_TYPE"),
                "graphicalSession": graphical_session(), "dependencies": dependencies,
                "accessibility": {"available": dependencies["Atspi"]["available"] and graphical_session(),
                                  "source": "atspi", "completeWindowList": False,
                                  "readiness": "bindings-detected; use desktop_list_apps to check the accessibility bus"},
                "portal": self.portal.capabilities(),
                "limitations": ["Logged-in, unlocked graphical session required",
                                "Accessibility coverage depends on the application",
                                "No compositor window activation or persistent Portal permission in this release",
                                "Coordinate input requires Portal logical stream size; no AT-SPI-to-image coordinate assumptions"]}

    def dispatch(self, tool, params, ctx):
        if tool == "desktop_get_capabilities":
            return self.capabilities()
        if tool == "desktop_stop":
            self.a11y.clear()
            self.portal.close()
            return {"sessionId": self.session_id, "stopped": True, "sharingClosed": True}
        if params.get("sessionId") != self.session_id:
            raise DesktopError("STALE_SESSION", "Missing or stale sessionId. Call desktop_get_capabilities again.")
        ctx.check()
        if tool == "desktop_list_apps":
            result = self.a11y.list_apps(ctx)
        elif tool == "desktop_list_windows":
            result = self.a11y.list_windows(params, ctx)
        elif tool == "desktop_observe":
            result = self.a11y.observe(params, ctx)
            if params.get("includeScreenshot"):
                result.update(self.portal.capture(params, ctx))
        elif tool == "desktop_start_session":
            result = self.portal.start(params, ctx)
        elif tool == "desktop_capture_screenshot":
            result = self.portal.capture(params, ctx)
        elif tool == "desktop_act":
            try:
                if params.get("action") in ("invoke", "set_text", "focus"):
                    result = self.a11y.act(params, ctx)
                else:
                    result = self.portal.act(params, ctx)
            finally:
                # An exception/timeout can follow an already delivered action.
                self.a11y.snapshots.clear()
                self.portal.frames.clear()
        elif tool == "desktop_wait_for":
            result = self.a11y.wait_for(params, ctx)
        else:
            raise DesktopError("UNKNOWN_TOOL", "Unknown desktop tool")
        ctx.check()
        return {"sessionId": self.session_id, **result}


def serve():
    agent = Agent()
    requests = queue.Queue(maxsize=33)  # One slot reserved for stop by the Bridge.
    cancel = threading.Event()
    output_lock = threading.Lock()
    cancellation_lock = threading.Lock()
    request_cancellations = {}

    def reply(value):
        with output_lock:
            sys.stdout.write(json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()

    def read():
        nonlocal cancel
        try:
            # Read on a separate thread: stop interrupts waits/Portal consent
            # without racing native UI actions or closing a live FD concurrently.
            while True:
                line = sys.stdin.buffer.readline(1024 * 1024 + 1)
                if not line:
                    break
                request_id = None
                try:
                    if len(line) > 1024 * 1024 or not line.endswith(b"\n"):
                        raise DesktopError("INVALID_REQUEST", "JSON request exceeds 1 MiB or is not newline-terminated")
                    request = json.loads(line)
                    request_id = request.get("id")
                    if request.get("type") == "cancel":
                        with cancellation_lock:
                            event = request_cancellations.get(request_id)
                            if event is not None:
                                event.set()
                        continue
                    if not isinstance(request_id, str) or not isinstance(request.get("tool"), str) or not isinstance(request.get("params", {}), dict):
                        raise DesktopError("INVALID_REQUEST", "Expected id, tool and params object")
                    if request["tool"] == "desktop_stop":
                        cancel.set()
                        cancel = threading.Event()
                    timeout = 110 if request["tool"] == "desktop_start_session" else 30
                    if request["tool"] == "desktop_wait_for":
                        timeout = max(0.001, min(30, request["params"].get("timeoutMs", 10_000) / 1000))
                    with cancellation_lock:
                        if request_id in request_cancellations:
                            raise DesktopError("INVALID_REQUEST", "Duplicate in-flight request id")
                        request_cancel = threading.Event()
                        request_cancellations[request_id] = request_cancel
                    try:
                        requests.put_nowait((request, Context(cancel, timeout, request_cancel)))
                    except Exception:
                        with cancellation_lock:
                            request_cancellations.pop(request_id, None)
                        raise
                except Exception as error:
                    reply({"id": request_id, "error": {"code": getattr(error, "code", "INVALID_REQUEST"), "message": str(error)}})
        finally:
            cancel.set()
            requests.put(None)

    def interrupted(_signum, _frame):
        cancel.set()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    threading.Thread(target=read, daemon=True, name="desktop-requests").start()
    try:
        while True:
            item = requests.get()
            if item is None:
                break
            request, ctx = item
            try:
                ctx.check()
                result = agent.dispatch(request["tool"], request.get("params", {}), ctx)
                reply({"id": request["id"], "result": result})
            except Exception as error:
                reply({"id": request["id"], "error": {"code": getattr(error, "code", "DESKTOP_ERROR"), "message": str(error)}})
            finally:
                with cancellation_lock:
                    request_cancellations.pop(request["id"], None)
    finally:
        cancel.set()
        agent.portal.close()


if __name__ == "__main__":
    serve()
