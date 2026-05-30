// 把 packages/extension/dist/ 打成 agentbridgelens-extension.zip（放仓库根目录）。
// 纯 Node 实现 ZIP（store/deflate），无外部依赖、跨平台（Windows 也可）。
// 用法：node scripts/zip-dist.mjs  （或 pnpm zip）
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const outFile = join(here, "..", "..", "..", "agentbridgelens-extension.zip");

if (!existsSync(distDir)) {
  console.error("dist/ 不存在，请先 `pnpm build`。");
  process.exit(1);
}

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function walk(dir, base, out) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push({ path: relative(base, full).split(sep).join("/"), data: readFileSync(full) });
  }
}

const files = [];
walk(distDir, distDir, files);
if (files.length === 0) {
  console.error("dist/ 为空，请先 `pnpm build`。");
  process.exit(1);
}

// 固定 DOS 时间戳（保证可复现，与 Date.now 无关）：1980-01-01 00:00
const DOS_TIME = 0;
const DOS_DATE = 0x21; // (1980-1980)<<9 | 1<<5 | 1

const locals = [];
const centrals = [];
let offset = 0;

for (const f of files) {
  const nameBuf = Buffer.from(f.path, "utf8");
  const crc = crc32(f.data);
  const compressed = deflateRawSync(f.data, { level: 9 });
  const useDeflate = compressed.length < f.data.length;
  const method = useDeflate ? 8 : 0;
  const body = useDeflate ? compressed : f.data;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(f.data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra len
  locals.push(local, nameBuf, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8); // flags
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(f.data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(offset, 42); // local header offset
  centrals.push(central, nameBuf);

  offset += local.length + nameBuf.length + body.length;
}

const localPart = Buffer.concat(locals);
const centralPart = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4); // disk
eocd.writeUInt16LE(0, 6); // disk w/ cd
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralPart.length, 12);
eocd.writeUInt32LE(localPart.length, 16);
eocd.writeUInt16LE(0, 20); // comment len

writeFileSync(outFile, Buffer.concat([localPart, centralPart, eocd]));
const kb = (statSync(outFile).size / 1024).toFixed(1);
console.log(`打包完成：${outFile} (${files.length} 个文件, ${kb} KB)`);
console.log(`在目标机解压后，chrome://extensions → 开发者模式 → 加载已解压 → 选解压出的目录。`);
