import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.tool === "desktop_act") process.exit(7);
  process.stdout.write(JSON.stringify({ id: request.id, result: { sessionId: String(process.pid), stopped: request.tool === "desktop_stop" } }) + "\n");
}
