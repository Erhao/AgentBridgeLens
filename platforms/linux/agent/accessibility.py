"""Bounded AT-SPI observation and semantic actions."""
import time

from common import DesktopError, References, binding, require_desktop


class Accessibility:
    def __init__(self):
        self.apps = References(ttl=300, capacity=128)
        self.windows = References(ttl=300, capacity=256)
        self.snapshots = References(ttl=60, capacity=8)
        self.atspi = None

    def api(self):
        require_desktop()
        if self.atspi is None:
            self.atspi = binding("Atspi", "2.0")
            self.atspi.init()
            self.atspi.set_timeout(500, 1500)
        return self.atspi

    def states(self, obj):
        state_set = obj.get_state_set()
        return {state.value_nick.replace("_", "-") for state in state_set.get_states()}

    def alive(self, obj):
        api = self.api()
        if obj is None:
            raise DesktopError("STALE_REFERENCE", "Accessible object no longer exists; observe again.")
        obj.clear_cache()
        if obj.get_state_set().contains(api.StateType.DEFUNCT):
            raise DesktopError("STALE_REFERENCE", "Accessible object no longer exists; observe again.")
        return obj

    def applications(self, ctx):
        desktop = self.api().get_desktop(0)
        if desktop is None:
            raise DesktopError("ACCESSIBILITY_UNAVAILABLE", "AT-SPI desktop is unavailable. Check the graphical user's accessibility bus.")
        count = desktop.get_child_count()
        result = []
        for index in range(min(count, 128)):
            ctx.check()
            obj = desktop.get_child_at_index(index)
            if obj is not None:
                result.append(obj)
        return result, count > 128

    def list_apps(self, ctx):
        objects, truncated = self.applications(ctx)
        result = []
        for obj in objects:
            ctx.check()
            try:
                result.append({"appId": self.apps.put(obj, "app"), "name": obj.get_name(), "pid": obj.get_process_id()})
            except DesktopError:
                raise
            except Exception:
                continue  # Applications can disappear during enumeration.
        return {"apps": result, "truncated": truncated, "source": "atspi"}

    def list_windows(self, params, ctx):
        api = self.api()
        if params.get("appId"):
            apps, truncated = [self.alive(self.apps.get(params["appId"]))], False
        else:
            apps, truncated = self.applications(ctx)
        roles = {api.Role.FRAME, api.Role.DIALOG, api.Role.WINDOW, api.Role.ALERT, api.Role.FILE_CHOOSER}
        result = []
        for app in apps:
            ctx.check()
            try:
                name = app.get_name()
                count = app.get_child_count()
                truncated = truncated or count > 128
                for index in range(min(count, 128)):
                    ctx.check()
                    obj = app.get_child_at_index(index)
                    if obj is not None and obj.get_role() in roles:
                        result.append({"windowId": self.windows.put(obj, "window"), "app": name,
                                       "name": obj.get_name(), "role": obj.get_role_name(),
                                       "states": sorted(self.states(obj))})
                    if len(result) >= 256:
                        return {"windows": result, "truncated": True, "source": "atspi"}
            except DesktopError:
                raise
            except Exception:
                continue
        return {"windows": result, "truncated": truncated, "source": "atspi"}

    def observe(self, params, ctx):
        self.api()
        root = self.alive(self.windows.get(params["windowId"]))
        max_depth, max_nodes = params.get("maxDepth", 6), params.get("maxNodes", 300)
        if not 0 <= max_depth <= 16 or not 1 <= max_nodes <= 1000:
            raise DesktopError("INVALID_ARGUMENT", "maxDepth must be 0..16 and maxNodes 1..1000")
        refs, nodes, visited = {}, [], set()
        queue = [(root, None, 0)]
        truncated = False
        skipped = 0
        while queue and len(nodes) < max_nodes:
            ctx.check()
            obj, parent, depth = queue.pop(0)
            if obj is None or hash(obj) in visited:
                continue
            visited.add(hash(obj))
            try:
                self.alive(obj)
                role, name = obj.get_role_name(), obj.get_name()
                interfaces = [item.split(".")[-1] for item in obj.get_interfaces()]
                node_id = "n" + str(len(nodes) + 1)
                node = {"id": node_id, "parent": parent, "role": role, "name": name,
                        "states": sorted(self.states(obj)), "interfaces": interfaces}
                # Only query declared interfaces; calling unsupported interfaces
                # can produce misleading empty values on some toolkits.
                if "Action" in interfaces:
                    action = obj.get_action_iface()
                    node["actions"] = [action.get_action_name(i) for i in range(min(action.get_n_actions(), 32))]
                protected = obj.get_role() == self.atspi.Role.PASSWORD_TEXT
                if protected:
                    node["protected"] = True
                elif params.get("includeText", False) and "Text" in interfaces:
                    try:
                        text = obj.get_text_iface()
                        size = text.get_character_count()
                        # Accessible.get_text is an old interface getter with
                        # the same Python name; use Text explicitly.
                        node["text"] = self.atspi.Text.get_text(text, 0, min(size, 2000))
                        node["textTruncated"] = size > 2000
                    except Exception:
                        node["textUnavailable"] = True
                refs[node_id] = (obj, role, name)
                nodes.append(node)
                children = obj.get_child_count()
                if depth >= max_depth:
                    truncated = truncated or children > 0
                    continue
                available = max_nodes - len(nodes) - len(queue)
                take = max(0, min(children, available, 128))
                truncated = truncated or take < children
                for index in range(take):
                    ctx.check()
                    queue.append((obj.get_child_at_index(index), node_id, depth + 1))
            except DesktopError:
                raise
            except Exception:
                skipped += 1
        ctx.check()
        snapshot_id = self.snapshots.put({"root": root, "nodes": refs}, "snapshot")
        return {"windowId": params["windowId"], "snapshotId": snapshot_id, "expiresInMs": 60_000,
                "nodes": nodes, "truncated": truncated or bool(queue), "skipped": skipped,
                "observedAt": time.time()}

    def act(self, params, ctx):
        self.api()
        if not params.get("snapshotId") or not params.get("target"):
            raise DesktopError("INVALID_ARGUMENT", "Semantic actions require snapshotId and target from desktop_observe")
        snapshot = self.snapshots.get(params["snapshotId"])
        self.alive(snapshot["root"])
        entry = snapshot["nodes"].get(params["target"])
        if entry is None:
            raise DesktopError("STALE_REFERENCE", "Target does not belong to this snapshot")
        obj, role, name = entry
        self.alive(obj)
        if obj.get_role_name() != role or obj.get_name() != name:
            raise DesktopError("STALE_REFERENCE", "Target's role/name changed; observe again")
        states = self.states(obj)
        if "sensitive" not in states:
            raise DesktopError("TARGET_DISABLED", "Target is not sensitive/enabled")
        interfaces = [item.split(".")[-1] for item in obj.get_interfaces()]
        ctx.check()
        accepted, verified = False, False
        action_name = params["action"]
        if action_name == "invoke":
            if "Action" not in interfaces:
                raise DesktopError("UNSUPPORTED_ACTION", "Target does not expose Action")
            action = obj.get_action_iface()
            names = [action.get_action_name(i) for i in range(min(action.get_n_actions(), 32))]
            selected = params.get("actionName")
            if selected is None and len(names) == 1:
                selected = names[0]
            if selected not in names:
                raise DesktopError("INVALID_ARGUMENT", "Choose an actionName returned by desktop_observe")
            self.snapshots.clear()  # Invalidate even if an application call fails.
            accepted = bool(action.do_action(names.index(selected)))
        elif action_name == "set_text":
            if "EditableText" not in interfaces or not isinstance(params.get("text"), str):
                raise DesktopError("UNSUPPORTED_ACTION", "set_text requires an EditableText target and text")
            if len(params["text"]) > 100_000:
                raise DesktopError("INVALID_ARGUMENT", "Text exceeds 100000 characters")
            self.snapshots.clear()
            accepted = bool(obj.get_editable_text_iface().set_text_contents(params["text"]))
            if accepted and obj.get_role() != self.atspi.Role.PASSWORD_TEXT and "Text" in interfaces:
                # Read back independently. Do not echo input or protected values.
                for _ in range(5):
                    ctx.check()
                    obj.clear_cache()
                    text = obj.get_text_iface()
                    count = text.get_character_count()
                    verified = count == len(params["text"]) and self.atspi.Text.get_text(text, 0, count) == params["text"]
                    if verified:
                        break
                    ctx.pause(0.1)
        elif action_name == "focus":
            if "Component" not in interfaces:
                raise DesktopError("UNSUPPORTED_ACTION", "Target does not expose Component")
            self.snapshots.clear()
            accepted = bool(obj.get_component_iface().grab_focus())
            obj.clear_cache()
            verified = accepted and "focused" in self.states(obj)
        else:
            raise DesktopError("UNSUPPORTED_ACTION", "Unknown semantic action")
        ctx.check()
        return {"accepted": accepted, "verified": verified, "action": action_name,
                "verification": "read-back" if verified else "Observe again to verify the task outcome"}

    def wait_for(self, params, ctx):
        if params.get("name") is None and params.get("role") is None:
            raise DesktopError("INVALID_ARGUMENT", "wait_for requires name and/or role")
        while True:
            result = self.observe({"windowId": params["windowId"], "maxDepth": 12, "maxNodes": 1000}, ctx)
            matches = [node["id"] for node in result["nodes"]
                       if (params.get("name") is None or node["name"] == params["name"])
                       and (params.get("role") is None or node["role"] == params["role"])]
            if matches:
                return {**result, "matches": matches}
            ctx.pause(0.2)

    def clear(self):
        self.apps.clear()
        self.windows.clear()
        self.snapshots.clear()
