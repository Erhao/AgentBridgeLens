import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function readToken(
  file = join(homedir(), ".agentbridgemac", "token"),
): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, randomBytes(32).toString("hex") + "\n");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(
      "Pairing token must be a regular owner-only file (chmod 600).",
    );
  }
  const token = readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error(
      "Invalid pairing token; expected 32 random bytes encoded as hex.",
    );
  return token;
}

export function readPort(raw = "19224"): number {
  if (!/^\d+$/.test(raw))
    throw new Error("BRIDGELENS_MAC_PORT must be an integer.");
  const port = Number(raw);
  if (port < 1024 || port > 65535)
    throw new Error("BRIDGELENS_MAC_PORT must be between 1024 and 65535.");
  return port;
}
