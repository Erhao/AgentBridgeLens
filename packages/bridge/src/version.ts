import { readFileSync } from "node:fs";

// Both source modules and the bundled dist/index.js are one directory below package.json.
export const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
