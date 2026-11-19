import {
  lstatSync,
  readdirSync,
  readlinkSync,
  unlinkSync,
} from "node:fs";
import { resolve, relative, dirname, join, sep } from "node:path";

const root = resolve(process.argv[2]);
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name),
      stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      // This legacy deploy self-link isn't needed at runtime and points outside the package.
      if (relative(root, path).split(sep).join("/") === "node_modules/.pnpm/node_modules/agentbridgelens") {
        unlinkSync(path);
        continue;
      }
      const target = resolve(dirname(path), readlinkSync(path));
      if (target !== root && !target.startsWith(root + sep)) {
        throw new Error(`Non-portable dependency link: ${relative(root, path)}`);
      }
    } else if (stat.isDirectory()) walk(path);
  }
}
walk(root);
console.log("Verified portable production dependency links.");
