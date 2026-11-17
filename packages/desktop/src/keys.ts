import { ExecutorError } from "@agentbridgelens/protocol";
export function namedKeys(value: unknown, mac = false): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 8 ||
    value.some((k) => typeof k !== "string" || k.length > 20)
  )
    throw new ExecutorError("INVALID_ARGUMENT", "Expected 1–8 named keys.");
  return value.map((k) => {
    const key = k.toUpperCase();
    return (
      (
        {
          PRIMARY: mac ? "CMD" : "CTRL",
          COMMAND: "CMD",
          CONTROL: "CTRL",
          OPTION: "ALT",
          ESCAPE: "ESC",
          RETURN: "ENTER",
        } as Record<string, string>
      )[key] ?? key
    );
  });
}
export function linuxKeys(value: unknown): number[] {
  if (Array.isArray(value) && value.every((k) => typeof k === "number"))
    return value;
  const codes: Record<string, number> = {
    CTRL: 29,
    SHIFT: 42,
    ALT: 56,
    META: 125,
    ENTER: 28,
    ESC: 1,
    TAB: 15,
    SPACE: 57,
    BACKSPACE: 14,
    DELETE: 111,
    INSERT: 110,
    HOME: 102,
    END: 107,
    PAGEUP: 104,
    PAGEDOWN: 109,
    UP: 103,
    DOWN: 108,
    LEFT: 105,
    RIGHT: 106,
  };
  for (const [letters, nums] of [
    ["QWERTYUIOP", [16, 17, 18, 19, 20, 21, 22, 23, 24, 25]],
    ["ASDFGHJKL", [30, 31, 32, 33, 34, 35, 36, 37, 38]],
    ["ZXCVBNM", [44, 45, 46, 47, 48, 49, 50]],
    ["1234567890", [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
  ] as const)
    for (let i = 0; i < letters.length; i++) codes[letters[i]] = nums[i];
  for (let i = 1; i <= 12; i++) codes[`F${i}`] = i <= 10 ? 58 + i : 76 + i;
  return namedKeys(value).map((key) => {
    if (!(key in codes))
      throw new ExecutorError(
        "UNSUPPORTED_CAPABILITY",
        `Unsupported Linux key: ${key}`,
      );
    return codes[key];
  });
}
