// 生成 AgentBridgeLens 扩展图标（纯 JS，无外部依赖）。
// 设计：蓝色圆角方形底 + 白色"镜头"环 + 中心点（呼应 BridgeLens 的 Lens）。
// 4x 超采样抗锯齿，输出 16/48/128/256 到 public/icons/。
// 用法：node scripts/gen-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "icons");

// ---- PNG 编码（RGBA, 8-bit）----
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
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw with per-scanline filter byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 绘制 ----
const TOP = [88, 166, 255]; // 顶部蓝
const BOT = [37, 99, 235]; // 底部蓝
const WHITE = [255, 255, 255];

// 在归一化坐标 (nx,ny ∈ [0,1]) 上判定一个子样本的颜色，返回 [r,g,b,a]（a: 0/255）
function sample(nx, ny) {
  const px = nx - 0.5;
  const py = ny - 0.5;
  // 圆角方形（半边 a，圆角 r）
  const a = 0.46;
  const r = 0.22;
  const qx = Math.max(Math.abs(px) - (a - r), 0);
  const qy = Math.max(Math.abs(py) - (a - r), 0);
  const d = Math.hypot(qx, qy) - r;
  if (d > 0) return [0, 0, 0, 0]; // 圆角外透明

  // 底色：竖直渐变
  const t = ny;
  let col = [
    Math.round(TOP[0] + (BOT[0] - TOP[0]) * t),
    Math.round(TOP[1] + (BOT[1] - TOP[1]) * t),
    Math.round(TOP[2] + (BOT[2] - TOP[2]) * t),
  ];

  // 镜头：白色环 + 中心点
  const rc = Math.hypot(px, py);
  if (rc >= 0.19 && rc <= 0.3) col = WHITE; // 环
  else if (rc <= 0.1) col = WHITE; // 中心点

  return [col[0], col[1], col[2], 255];
}

function render(size) {
  const ss = 4; // 超采样倍率
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, alpha = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const nx = (x + (sx + 0.5) / ss) / size;
          const ny = (y + (sy + 0.5) / ss) / size;
          const [pr, pg, pb, pa] = sample(nx, ny);
          if (pa > 0) {
            r += pr;
            g += pg;
            b += pb;
            alpha += 255;
          }
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      // 预乘平均：颜色按覆盖到的子样本数平均（避免边缘发黑）
      const cover = alpha / 255;
      rgba[i] = cover ? Math.round(r / cover) : 0;
      rgba[i + 1] = cover ? Math.round(g / cover) : 0;
      rgba[i + 2] = cover ? Math.round(b / cover) : 0;
      rgba[i + 3] = Math.round(alpha / n);
    }
  }
  return encodePNG(size, rgba);
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128, 256]) {
  writeFileSync(join(outDir, `icon${size}.png`), render(size));
  console.log(`wrote icon${size}.png`);
}
