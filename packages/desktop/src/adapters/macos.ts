import { randomUUID } from "node:crypto";
import {
  NativeChannel,
  readToken,
  readPort,
  type DesktopExecutor,
} from "@agentbridgelens/runtime";
import { ExecutorError } from "@agentbridgelens/protocol";
import { namedKeys } from "../keys.js";

type Endpoint = Pick<NativeChannel, "status" | "send" | "close">;
type Observation = { windowId: string; created: number; raw: any };
const roles: Record<string, string> = {
  AXWindow: "window",
  AXButton: "button",
  AXTextField: "edit",
  AXTextArea: "document",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio",
  AXStaticText: "text",
  AXScrollArea: "scroll-area",
  AXMenu: "menu",
  AXMenuItem: "menu-item",
  AXPopUpButton: "combobox",
  AXTable: "table",
  AXRow: "row",
  AXCell: "cell",
  AXGroup: "group",
};

/** Adapts installed Mac native wire v1 to the common desktop contract. */
export class MacDesktop implements DesktopExecutor {
  readonly platform = "darwin" as const;
  private seenSession: string | null = null;
  private observations = new Map<string, Observation>();
  private frames = new Map<string, string>();
  private grant?: {
    windowId: string;
    input: boolean;
    epoch?: number;
    created: number;
  };
  private closed = false;
  private generation = 0;
  constructor(
    readonly channel: Endpoint,
    readonly remote = false,
  ) {}
  static async create(remoteToken?: string) {
    const port = readPort(
      process.env.BRIDGELENS_MAC_PORT ?? process.env.AGENTBRIDGEMAC_PORT,
    );
    const token = remoteToken ?? readToken(
      process.env.BRIDGELENS_MAC_TOKEN_FILE ??
        process.env.AGENTBRIDGEMAC_TOKEN_FILE,
    );
    const channel = new NativeChannel({ port, token });
    try {
      await channel.listen();
    } catch (error) {
      await channel.close();
      throw error;
    }
    console.error(
      `[BridgeLens] Mac native companion ws://127.0.0.1:${port}/native`,
    );
    return new MacDesktop(channel, remoteToken !== undefined);
  }
  private sync() {
    if (this.seenSession !== this.channel.status.sessionId) {
      this.clear();
      this.seenSession = this.channel.status.sessionId;
    }
    for (const [id, item] of this.observations)
      if (Date.now() - item.created >= 30000) this.observations.delete(id);
    for (const [id, snapshot] of this.frames)
      if (!this.observations.has(snapshot)) this.frames.delete(id);
  }
  private clear() {
    this.generation++;
    this.grant = undefined;
    this.observations.clear();
    this.frames.clear();
  }
  private session(params: Record<string, unknown>) {
    this.sync();
    if (!this.channel.status.connected)
      throw new ExecutorError(
        "NOT_CONNECTED",
        "Open the Mac menu-bar app and connect it to this Bridge.",
      );
    if (params.sessionId !== this.seenSession)
      throw new ExecutorError(
        "STALE_SESSION",
        "Call desktop_get_capabilities after reconnecting.",
      );
  }
  private stream(params: Record<string, unknown>) {
    if (params.streamId !== undefined && params.streamId !== 1)
      throw new ExecutorError(
        "INVALID_ARGUMENT",
        "Mac supports only streamId 1.",
      );
  }
  private async permission(input: boolean, signal?: AbortSignal) {
    if (
      !this.grant ||
      Date.now() - this.grant.created > 300000 ||
      (input && !this.grant.input)
    )
      throw new ExecutorError(
        "PERMISSION_REQUIRED",
        "Start a session for this window, with input:true for mutations.",
      );
    const grant = this.grant;
    const status = await this.channel.send("mac_get_status", {}, signal);
    if (this.grant !== grant)
      throw new ExecutorError(
        "CANCELLED",
        "Authorization changed during this request.",
      );
    if (
      (input && !status.controlEnabled) ||
      (grant.epoch !== undefined && grant.epoch !== status.controlEpoch)
    ) {
      this.clear();
      throw new ExecutorError(
        "CONTROL_DISABLED",
        "Control changed locally. Re-enable in the Mac app and start a fresh session.",
      );
    }
    return grant;
  }
  private observation(id: unknown) {
    if (typeof id !== "string" || !this.observations.has(id))
      throw new ExecutorError(
        "STALE_REFERENCE",
        "Observe or capture again; reference is stale.",
      );
    return this.observations.get(id)!;
  }
  private normalize(raw: any, windowId: string, includeText: boolean) {
    const nodes = (raw.elements ?? []).map((node: any) => ({
      id: node.id,
      parent: node.parentId ?? null,
      role: roles[node.role] ?? node.role,
      rawRole: node.role,
      name: node.name,
      states: node.enabled ? ["enabled"] : ["disabled"],
      protected: !!node.secure,
      bounds: node.frame,
      actions: (node.actions ?? []).filter(
        (name: string) => name === "AXPress",
      ),
      nativeActions: node.actions ?? [],
      interfaces: [
        ...(node.valueSettable ? ["EditableText"] : []),
        ...((node.actions ?? []).includes("AXPress") ? ["Action"] : []),
      ],
      ...(includeText && !node.secure && typeof node.value === "string"
        ? { text: node.value }
        : {}),
    }));
    this.observations.set(raw.snapshotId, {
      windowId,
      created: Date.now(),
      raw,
    });
    while (this.observations.size > 8)
      this.observations.delete(this.observations.keys().next().value!);
    let screenshot;
    if (raw.screenshot) {
      const screenshotId = `image-${raw.snapshotId}`;
      this.frames.set(screenshotId, raw.snapshotId);
      screenshot = {
        ...raw.screenshot,
        screenshotId,
        streamId: 1,
        windowId,
        coordinateSpace: "image-pixels-top-left",
      };
    }
    return {
      sessionId: this.seenSession,
      windowId,
      snapshotId: raw.snapshotId,
      expiresInMs: Math.min(raw.expiresInMs ?? 30000, 30000),
      nodes,
      truncated: !!raw.truncated,
      skipped: 0,
      warnings: raw.warnings,
      ...(screenshot ? { screenshot } : {}),
    };
  }
  async send(
    tool: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<any> {
    if (this.closed)
      throw new ExecutorError("DISCONNECTED", "Desktop executor is closed");
    this.sync();
    if (tool === "desktop_get_capabilities") {
      const status = this.channel.status;
      const native = status.connected
        ? await this.channel.send("mac_get_status", {}, signal)
        : null;
      return {
        sessionId: status.sessionId,
        platform: "darwin",
        connected: status.connected,
        graphicalSession: status.connected,
        accessibility: {
          available: !!native?.permissions?.accessibility,
          source: "macos-ax",
          completeWindowList: false,
        },
        capture: {
          available: !!native?.permissions?.screenCapture,
          source: "ScreenCaptureKit",
          targetKinds: ["window"],
          active: !!this.grant,
          inputAllowed: !!this.grant?.input && !!native?.controlEnabled,
        },
        input: {
          requiresLocalConsent: true,
          requiresForeground: true,
          actions: [
            "invoke",
            "set_text",
            "focus-window",
            "click",
            "scroll",
            "press_keys",
          ],
          pointerButtons: ["left"],
          namedKeys: true,
        },
        native,
        limitations: [
          "One scoped window; grant expires in five minutes or on connection/control changes.",
          "The Mac app must enable control locally. start_session cannot grant OS permissions.",
          "No node focus, pointer move, horizontal scroll or non-left clicks in native wire v1.",
        ],
      };
    }
    if (tool === "desktop_stop") {
      this.clear();
      if (this.channel.status.connected)
        await this.channel.send("mac_stop", {}, signal);
      return {
        sessionId: this.channel.status.sessionId,
        stopped: true,
        sharingClosed: true,
      };
    }
    this.session(params);
    this.stream(params);
    if (tool === "desktop_list_windows" || tool === "desktop_list_apps") {
      const raw = await this.channel.send("mac_list_windows", {}, signal);
      const windows = (raw.windows ?? []).map((w: any) => ({
        ...w,
        windowId: w.windowRef,
        appId: `process-${w.pid}`,
        name: w.title,
        role: "window",
        bounds: w.frame,
      }));
      if (tool === "desktop_list_apps")
        return {
          sessionId: this.seenSession,
          apps: [
            ...new Map(
              windows.map((w: any) => [
                w.appId,
                { appId: w.appId, pid: w.pid, name: w.app },
              ]),
            ).values(),
          ],
          warnings: raw.warnings,
        };
      return {
        sessionId: this.seenSession,
        windows: windows.filter(
          (w: any) => !params.appId || w.appId === params.appId,
        ),
        warnings: raw.warnings,
      };
    }
    if (tool === "desktop_start_session") {
      this.clear();
      const generation = this.generation;
      if (params.multiple)
        throw new ExecutorError(
          "UNSUPPORTED_CAPABILITY",
          "Mac supports one window per session.",
        );
      if (typeof params.windowId !== "string")
        throw new ExecutorError("INVALID_ARGUMENT", "windowId is required.");
      const raw = await this.channel.send("mac_list_windows", {}, signal);
      if (
        !(raw.windows ?? []).some((w: any) => w.windowRef === params.windowId)
      )
        throw new ExecutorError("STALE_REFERENCE", "List windows again.");
      const status = await this.channel.send("mac_get_status", {}, signal);
      if (!status.permissions?.screenCapture)
        throw new ExecutorError(
          "SCREEN_CAPTURE_DENIED",
          "Grant Screen Recording access in the Mac app.",
        );
      if (params.input && !status.controlEnabled)
        throw new ExecutorError(
          "CONTROL_DISABLED",
          "Enable control locally in the Mac menu-bar app.",
        );
      if (params.input)
        await this.channel.send(
          "mac_focus_window",
          { windowRef: params.windowId },
          signal,
        );
      if (generation !== this.generation)
        throw new ExecutorError(
          "CANCELLED",
          "Session cancelled during authorization.",
        );
      this.grant = {
        windowId: params.windowId,
        input: params.input === true,
        epoch: status.controlEpoch,
        created: Date.now(),
      };
      return {
        sessionId: this.seenSession,
        active: true,
        inputAllowed: this.grant.input,
        windowId: params.windowId,
        streams: [{ streamId: 1, windowId: params.windowId }],
      };
    }
    if (tool === "desktop_observe") {
      if (params.includeScreenshot) {
        const grant = await this.permission(false, signal);
        if (params.windowId !== grant.windowId)
          throw new ExecutorError(
            "PERMISSION_REQUIRED",
            "The window is outside the approved capture session.",
          );
      }
      const raw = await this.channel.send(
        "mac_observe",
        {
          windowRef: params.windowId,
          maxDepth: this.channel.status.device?.version.startsWith("0.1.")
            ? Math.max(1, Math.min(15, Number(params.maxDepth ?? 6)))
            : (params.maxDepth ?? 6),
          maxNodes: params.maxNodes ?? 300,
          includeText: params.includeText === true,
          screenshot: params.includeScreenshot === true,
        },
        signal,
      );
      return this.normalize(
        raw,
        String(params.windowId),
        params.includeText === true,
      );
    }
    if (tool === "desktop_capture_screenshot") {
      const grant = await this.permission(false, signal);
      const raw = await this.channel.send(
        "mac_observe",
        {
          windowRef: grant.windowId,
          maxDepth: this.channel.status.device?.version.startsWith("0.1.")
            ? 1
            : 0,
          maxNodes: 1,
          includeText: false,
          screenshot: true,
        },
        signal,
      );
      const result = this.normalize(raw, grant.windowId, false);
      return { sessionId: this.seenSession, screenshot: result.screenshot };
    }
    if (tool === "desktop_wait_for") {
      if (params.name === undefined && params.role === undefined)
        throw new ExecutorError("INVALID_ARGUMENT", "Specify name or role.");
      const rawRole =
        Object.entries(roles).find(([, value]) => value === params.role)?.[0] ??
        params.role;
      const result = await this.channel.send(
        "mac_wait_for",
        {
          windowRef: params.windowId,
          name: params.name,
          role: rawRole,
          timeoutMs: Math.min(Number(params.timeoutMs ?? 10000), 25000),
          includeText: false,
        },
        signal,
      );
      this.observations.clear();
      this.frames.clear();
      // Native wait v1 returns matching elements only, so keep the native refs scoped.
      const normalized = this.normalize(
        { ...result, elements: result.elements ?? [], expiresInMs: 30000 },
        String(params.windowId),
        false,
      );
      return { ...normalized, matches: normalized.nodes.map((n: any) => n.id) };
    }
    if (tool === "desktop_act") {
      const grant = await this.permission(true, signal);
      try {
        const semantic = ["invoke", "set_text", "focus"].includes(
          String(params.action),
        );
        const snapshotId = semantic
          ? params.snapshotId
          : this.frames.get(String(params.screenshotId));
        const snapshot = this.observation(snapshotId);
        if (snapshot.windowId !== grant.windowId)
          throw new ExecutorError(
            "PERMISSION_REQUIRED",
            "Target is outside the approved window.",
          );
        let operation: Record<string, unknown>;
        if (semantic) {
          const element = (snapshot.raw.elements ?? []).find(
            (n: any) => n.id === params.target,
          );
          if (!element)
            throw new ExecutorError(
              "STALE_REFERENCE",
              "Target is not in this snapshot.",
            );
          if (params.action === "focus") {
            if (element.role !== "AXWindow")
              throw new ExecutorError(
                "UNSUPPORTED_CAPABILITY",
                "Native wire v1 supports window focus only.",
              );
            const result = await this.channel.send(
              "mac_focus_window",
              { windowRef: snapshot.windowId },
              signal,
            );
            return {
              sessionId: this.seenSession,
              accepted: true,
              verified: result.verified === true,
            };
          }
          if (params.action === "set_text") {
            if (typeof params.text !== "string" || params.text.length > 20000)
              throw new ExecutorError(
                "INVALID_ARGUMENT",
                "Mac text limit is 20000 characters.",
              );
            operation = {
              action: "set_value",
              elementId: params.target,
              text: params.text,
            };
          } else {
            if (
              params.actionName !== undefined &&
              params.actionName !== "AXPress"
            )
              throw new ExecutorError(
                "UNSUPPORTED_CAPABILITY",
                "Native wire v1 supports AXPress only.",
              );
            operation = { action: "press", elementId: params.target };
          }
        } else if (params.action === "click") {
          if (params.button !== undefined && params.button !== "left")
            throw new ExecutorError(
              "UNSUPPORTED_CAPABILITY",
              "Native wire v1 supports left click only.",
            );
          operation = { action: "click_point", x: params.x, y: params.y };
        } else if (params.action === "scroll") {
          if (
            Number(params.dx ?? 0) !== 0 ||
            !Number.isFinite(params.dy) ||
            Number(params.dy) === 0
          )
            throw new ExecutorError(
              "UNSUPPORTED_CAPABILITY",
              "Mac supports nonzero vertical scrolling only.",
            );
          if (this.channel.status.device?.version?.startsWith("0.1."))
            throw new ExecutorError(
              "UNSUPPORTED_CAPABILITY",
              "Positioned scrolling requires Mac companion 0.2.0 or later.",
            );
          operation = {
            action: "scroll",
            deltaY: -Math.round(Number(params.dy)),
            x: params.x,
            y: params.y,
          };
        } else if (params.action === "press_keys") {
          const keys = namedKeys(params.keys, true),
            modifiers: string[] = [],
            plain: string[] = [];
          const mods: Record<string, string> = {
            CMD: "command",
            CTRL: "control",
            SHIFT: "shift",
            ALT: "option",
          };
          for (const key of keys)
            if (mods[key]) modifiers.push(mods[key]);
            else plain.push(key);
          const aliases: Record<string, string> = {
            ENTER: "return",
            ESC: "escape",
            PAGEUP: "pageup",
            PAGEDOWN: "pagedown",
          };
          if (
            plain.length !== 1 ||
            new Set(modifiers).size !== modifiers.length
          )
            throw new ExecutorError(
              "INVALID_ARGUMENT",
              "One key and distinct modifiers required.",
            );
          const key = aliases[plain[0]] ?? plain[0].toLowerCase();
          if (
            ![
              "return",
              "escape",
              "tab",
              "space",
              "backspace",
              "delete",
              "up",
              "down",
              "left",
              "right",
              "home",
              "end",
              "pageup",
              "pagedown",
              "a",
              "c",
              "v",
              "s",
              "z",
            ].includes(key)
          )
            throw new ExecutorError(
              "UNSUPPORTED_CAPABILITY",
              "Key is not supported by native wire v1.",
            );
          operation = { action: "key", key, modifiers };
        } else
          throw new ExecutorError(
            "UNSUPPORTED_CAPABILITY",
            "Action is not supported by the Mac executor.",
          );
        const result = await this.channel.send(
          "mac_act",
          { snapshotId, operation },
          signal,
        );
        return {
          sessionId: this.seenSession,
          accepted: result.dispatched === true,
          verified: result.verified === true,
          action: params.action,
          detail: result.detail,
        };
      } finally {
        this.observations.clear();
        this.frames.clear();
      }
    }
    throw new ExecutorError("UNKNOWN_TOOL", "Unknown desktop tool.");
  }
  async sendLegacy(
    tool: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    this.sync();
    try {
      return await this.channel.send(tool, params, signal);
    } finally {
      if (["mac_act", "mac_stop", "mac_focus_window"].includes(tool)) {
        this.observations.clear();
        this.frames.clear();
        if (tool === "mac_stop") this.grant = undefined;
      }
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.clear();
    void this.channel.close();
  }
  async stopAndClose() {
    if (this.closed) return;
    try {
      if (this.channel.status.connected)
        await this.channel.send("mac_stop", {}, AbortSignal.timeout(3000));
    } catch {
    } finally {
      this.close();
    }
  }
}
