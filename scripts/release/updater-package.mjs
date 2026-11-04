import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Small reproducible ZIP writer; updater bundle needs no compression. */
export function createZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data: value, mode = 0o100644 } of entries) {
    const filename = Buffer.from(name), data = Buffer.from(value);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

export async function packageUpdater(cwd, out) {
  const entries = [];
  for (const name of ["update-extension.mjs", "update-extension.cmd", "update-extension.command", "update-extension.sh", "README.txt"]) {
    entries.push({ name, data: await readFile(join(cwd, "scripts/update", name)), mode: /\.(command|sh)$/.test(name) ? 0o100755 : 0o100644 });
  }
  const zip = createZip(entries), name = "agentbridgelens-updater.zip";
  await writeFile(join(out, name), zip);
  await writeFile(join(out, `${name}.sha256`), `${createHash("sha256").update(zip).digest("hex")}  ${name}\n`);
}
