"""Protocol fixture only; never used by the actual executor."""
import json
import os
import sys
import threading

lock = threading.Lock()
cancel = threading.Event()


def reply(request, result=None, error=None):
    with lock:
        print(json.dumps({"id": request["id"], **({"error": error} if error else {"result": result})}), flush=True)


def wait(request, event):
    event.wait(10)
    reply(request, error={"code": "CANCELLED", "message": "Stopped"})


for line in sys.stdin:
    request = json.loads(line)
    tool, params = request["tool"], request["params"]
    if tool == "desktop_get_capabilities":
        reply(request, {"sessionId": str(os.getpid()), "graphicalSession": True})
    elif tool == "desktop_stop":
        cancel.set()
        cancel = threading.Event()
        reply(request, {"stopped": True})
    elif tool == "desktop_wait_for":
        threading.Thread(target=wait, args=(request, cancel), daemon=True).start()
    elif params.get("target") == "crash":
        os._exit(7)
    elif params.get("target") == "invalid-json":
        print("not json", flush=True)
    elif tool in ("desktop_capture_screenshot", "desktop_observe"):
        reply(request, {"sessionId": params["sessionId"], "screenshot": {
            "data": "iVBORw0KGgo=", "width": 1, "height": 1, "screenshotId": "frame-1"}})
    else:
        reply(request, {"accepted": True, "verified": False, "action": params.get("action")})
