"""Shared limits and lazy GNOME bindings. No third-party Python packages required."""
import importlib
import os
import threading
import time
import uuid


class DesktopError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def identifier(prefix):
    return prefix + "-" + uuid.uuid4().hex


def graphical_session():
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def require_desktop():
    if not graphical_session():
        raise DesktopError("NO_DESKTOP", "No graphical session. Start the Bridge as the logged-in desktop user, with its DISPLAY/WAYLAND_DISPLAY and session D-Bus environment.")


_bindings = {}
_loop = None


def binding(name, version):
    global _loop
    if name not in _bindings:
        try:
            gi = importlib.import_module("gi")
            gi.require_version(name, version)
            _bindings[name] = importlib.import_module("gi.repository." + name)
            if _loop is None:
                GLib = importlib.import_module("gi.repository.GLib")
                _loop = GLib.MainLoop()
                threading.Thread(target=_loop.run, daemon=True, name="desktop-glib").start()
        except (ImportError, ValueError) as error:
            raise DesktopError("MISSING_DEPENDENCY", "Missing " + name + " introspection bindings. See docs/LINUX-DESKTOP.md; use /usr/bin/python3 with Ubuntu's python3-gi packages.") from error
    return _bindings[name]


class LinkedCancellation:
    def __init__(self, parent, request):
        self.parent, self.request = parent, request

    def is_set(self):
        return self.parent.is_set() or self.request.is_set()

    def set(self):
        self.request.set()

    def wait(self, timeout):
        deadline = time.monotonic() + timeout
        while not self.is_set() and time.monotonic() < deadline:
            self.request.wait(min(0.025, max(0, deadline - time.monotonic())))
        return self.is_set()


class Context:
    def __init__(self, cancel=None, timeout=30, request_cancel=None):
        parent = cancel or threading.Event()
        self.cancel = LinkedCancellation(parent, request_cancel) if request_cancel is not None else parent
        self.deadline = time.monotonic() + timeout

    def check(self):
        if self.cancel.is_set():
            raise DesktopError("CANCELLED", "Desktop work was stopped. An in-flight action may have occurred; observe again before retrying.")
        if time.monotonic() >= self.deadline:
            raise DesktopError("TIMEOUT", "Desktop operation timed out; observe again before retrying actions.")

    def pause(self, seconds):
        self.check()
        self.cancel.wait(min(seconds, max(0, self.deadline - time.monotonic())))
        self.check()


class References:
    """Bounded references tied to one executor; never persistent object indexes."""
    def __init__(self, ttl=60, capacity=8):
        self.ttl = ttl
        self.capacity = capacity
        self.items = {}

    def put(self, value, prefix):
        now = time.monotonic()
        self.items = {key: item for key, item in self.items.items() if now - item[0] < self.ttl}
        while len(self.items) >= self.capacity:
            self.items.pop(next(iter(self.items)))
        key = identifier(prefix)
        self.items[key] = (now, value)
        return key

    def get(self, key):
        item = self.items.get(key)
        if item is None or time.monotonic() - item[0] >= self.ttl:
            self.items.pop(key, None)
            raise DesktopError("STALE_REFERENCE", "Reference expired or was invalidated. List windows/observe/capture again.")
        return item[1]

    def clear(self):
        self.items.clear()
