import {
  lstatSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { resolve, relative, dirname, join, sep } from "node:path";

const root = resolve(process.argv[2]);
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name),
      stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(path), readlinkSync(path));
      if (target !== root && !target.startsWith(root + sep)) {
        // pnpm legacy deploy leaves its self-reference pointing at the source workspace.
        if (
          relative(root, path).split(sep).join("/") ===
          "node_modules/.pnpm/node_modules/agentbridgelens"
        ) {
          unlinkSync(path);
          symlinkSync(relative(dirname(path), root), path);
        } else
          throw new Error(
            `Non-portable dependency link: ${relative(root, path)}`,
          );
      }
    } else if (stat.isDirectory()) walk(path);
  }
}
walk(root);
console.log("Verified portable production dependency links.");
