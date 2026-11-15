// 文字読み取り。WSL の tesseract 5.3.4 で PNG を文字にする。
// 大文字にして空白を除き、値と 8 字以上続けて一致するかを返す。
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import zlib from "node:zlib";

import { WSL_DISTRO, wslArgs, winToWsl } from "./wsl.mjs";
export { WSL_DISTRO, winToWsl };

export const normalize = (s) => String(s).toUpperCase().replace(/\s+/g, "");

/** a と b の最も長い共通の連続部分の長さ（コードポイント単位） */
export function longestCommonRun(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  if (!x.length || !y.length) return 0;
  let best = 0;
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

function run(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const c = spawn("wsl.exe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.setEncoding("utf8");
    c.stderr.setEncoding("utf8");
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => c.kill(), timeoutMs);
    c.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
    c.on("error", () => {
      clearTimeout(t);
      resolve({ code: -1, out, err });
    });
  });
}

// ---- 前処理: 外の道具が無いので PNG を自分で読んで、2 倍に拡大した白黒の画像を作る（枠線・点滅の棒に読み取りが負けないように）----
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("PNG ではない");
  let pos = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let ctype = 0;
  let interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (depth !== 8 || !ch || interlace !== 0) throw new Error("この PNG の形は前処理しない");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[y * stride + x - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
      let v = src[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  // 明るさ（0〜255）にする
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * ch;
    gray[i] = ch >= 3 ? Math.round(0.299 * out[o] + 0.587 * out[o + 1] + 0.114 * out[o + 2]) : out[o];
  }
  return { w, h, gray };
}

function encodeGrayPng(w, h, pix) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    Buffer.from(pix.buffer, pix.byteOffset + y * w, w).copy(raw, y * (w + 1) + 1);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** 元の写真から、しきい値を変えた 2 倍の白黒画像を作る。しきい値 100: 暗い字だけ（枠線は消える）。200: 薄い字も残す。 */
export function makeVariants(pngPath) {
  const out = [];
  try {
    const { w, h, gray } = decodePng(readFileSync(pngPath));
    for (const thr of [100, 200]) {
      const W = w * 2;
      const H = h * 2;
      const pix = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) pix[y * W + x] = gray[(y >> 1) * w + (x >> 1)] < thr ? 0 : 255;
      const p = pngPath.replace(/\.png$/i, "") + `.thr${thr}.png`;
      writeFileSync(p, encodeGrayPng(W, H, pix));
      out.push(p);
    }
  } catch {
    // 前処理できない形なら元の写真だけで読む
  }
  return out;
}

/** PNG を文字にする。psm を変えて何回か読み、全部つなげて返す。 */
export async function ocrPng(pngPath, { psms = [6, 11] } = {}) {
  const files = [pngPath, ...makeVariants(pngPath)];
  let text = "";
  let okRuns = 0;
  for (const f of files) {
    for (const psm of psms) {
      const r = await run(wslArgs("tesseract", winToWsl(f), "stdout", "--psm", String(psm), "-l", "eng"));
      if (r.code === 0) okRuns++;
      text += r.out + "\n";
    }
  }
  return { text, okRuns };
}

/**
 * PNG を読んで value と比べる。
 * 戻り値: {maxRun, found, sanityOk, okRuns}。文字そのものは返さず、textFile に保存する。
 * sanity: 画面の見出しなど、写真に必ず写っているはずの文字（読めない写真を「値なし」と数えないため）
 */
export async function ocrCheck(pngPath, values, { minRun = 8, sanity = null, textFile = null } = {}) {
  const { text, okRuns } = await ocrPng(pngPath);
  if (textFile) writeFileSync(textFile, text);
  const norm = normalize(text);
  const list = Array.isArray(values) ? values : [values];
  const runs = list.map((v) => longestCommonRun(norm, normalize(v)));
  const maxRun = Math.max(0, ...runs);
  return {
    maxRun,
    runs,
    found: runs.map((r) => r >= minRun),
    anyFound: maxRun >= minRun,
    sanityOk: sanity ? norm.includes(normalize(sanity)) : null,
    okRuns,
  };
}
