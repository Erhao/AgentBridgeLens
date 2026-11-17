import { z } from "zod";
export * from "./browser.js";
export type DesktopPlatform = "linux" | "win32" | "darwin";
export const nativeProtocolVersion = 1;
export const nativeHello = z.object({
  type: z.literal("hello"),
  protocolVersion: z.literal(nativeProtocolVersion),
  deviceId: z.string().min(1).max(200),
  version: z.string().min(1).max(50),
  capabilities: z.array(z.string().max(100)).max(100),
});
export const executorResponse = z
  .object({
    id: z.string().min(1).max(200),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.string().optional(), message: z.string() })
      .optional(),
  })
  .refine(
    (v) =>
      v.error !== undefined ||
      Object.prototype.hasOwnProperty.call(v, "result"),
    "Missing result or error",
  );
export const session = {
  sessionId: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Executor session, scoped to this connection/process. Re-read capabilities after reconnect.",
    ),
};
export const namedKeys = z.array(z.string().min(1).max(20)).min(1).max(8);
const evdevKeys = z.array(z.number().int().min(1).max(767)).min(1).max(8);

/** Public desktop v1 schemas. Numeric Linux keys remain a compatibility input. */
export function desktopSchemas(platform: DesktopPlatform) {
  return {
    desktop_get_capabilities: {},
    desktop_list_apps: session,
    desktop_list_windows: { ...session, appId: z.string().optional() },
    desktop_observe: {
      ...session,
      windowId: z.string().min(1),
      maxDepth: z.number().int().min(0).max(16).default(6),
      maxNodes: z.number().int().min(1).max(1000).default(300),
      includeText: z.boolean().default(false),
      includeScreenshot: z.boolean().default(false),
      streamId: z.number().int().positive().optional(),
    },
    desktop_start_session: {
      ...session,
      ...(platform === "linux" ? {} : { windowId: z.string().min(1) }),
      input: z.boolean().default(false),
      multiple: z.boolean().default(false),
    },
    desktop_capture_screenshot: {
      ...session,
      streamId: z.number().int().positive().optional(),
    },
    desktop_act: {
      ...session,
      action: z.enum([
        "invoke",
        "set_text",
        "focus",
        "click",
        "move",
        "scroll",
        "press_keys",
      ]),
      snapshotId: z.string().optional(),
      target: z.string().optional(),
      actionName: z.string().max(100).optional(),
      text: z.string().max(100_000).optional(),
      screenshotId: z.string().optional(),
      x: z.number().finite().nonnegative().optional(),
      y: z.number().finite().nonnegative().optional(),
      button: z.enum(["left", "middle", "right"]).default("left"),
      dx: z.number().min(-1000).max(1000).optional(),
      dy: z.number().min(-1000).max(1000).optional(),
      keys: (platform === "linux" ? z.union([namedKeys, evdevKeys]) : namedKeys)
        .optional()
        .describe(
          "Named keys, e.g. [PRIMARY,S], [ENTER]. PRIMARY is Command on Mac, Ctrl elsewhere. Linux numeric evdev keys remain compatible. Not text input.",
        ),
    },
    desktop_wait_for: {
      ...session,
      windowId: z.string().min(1),
      name: z.string().max(1000).optional(),
      role: z.string().max(100).optional(),
      timeoutMs: z.number().int().min(1).max(30_000).default(10_000),
    },
    desktop_stop: {},
  };
}

export class ExecutorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}

/** Cross-field requirements shared by every desktop MCP adapter. */
export function validateDesktopAction(args: Record<string, unknown>) {
  const required = (key: string) => {
    if (typeof args[key] !== "string" || !(args[key] as string).length)
      throw new ExecutorError(
        "INVALID_ARGUMENT",
        `${key} is required for ${args.action}.`,
      );
  };
  if (["invoke", "set_text", "focus"].includes(String(args.action))) {
    required("snapshotId");
    required("target");
    if (args.action === "set_text" && typeof args.text !== "string")
      throw new ExecutorError("INVALID_ARGUMENT", "set_text requires text.");
  } else {
    required("screenshotId");
    if (args.action === "press_keys") {
      if (!Array.isArray(args.keys) || !args.keys.length)
        throw new ExecutorError(
          "INVALID_ARGUMENT",
          "press_keys requires keys.",
        );
    } else if (!Number.isFinite(args.x) || !Number.isFinite(args.y))
      throw new ExecutorError(
        "INVALID_ARGUMENT",
        "Pointer actions require image-pixel x/y.",
      );
    if (
      args.action === "scroll" &&
      !Number(args.dx ?? 0) &&
      !Number(args.dy ?? 0)
    )
      throw new ExecutorError(
        "INVALID_ARGUMENT",
        "scroll requires nonzero dx or dy.",
      );
  }
}
