// 漏れ探し。値を形を変えて探す。入力係の leak-guard とは別に書いている（同じ見落としを持たないため）。
//
// モジュール:
//   buildForms(value, {id}) -> [{form, needle}]      探す形の一覧（needle は小文字にしたバイト列を latin1 の文字列にした物）
//   scanBuffer(buf, forms)  -> {total, forms:{形:件数}}
//   scanTree({roots, needles, since, maxBytes, chunkBytes}) -> 結果（値は含めない）
//     結果の数: scanned（探した）・skippedOld（試験の前からある物で飛ばした）・skippedLarge（上限 maxBytes を超えて探せなかった）・
//               unreadable（読めなかった）・unreadableOldDirs（中を読めないが自身の日時が since より古いフォルダ。判定不能にしない）・missingRoots（無かった探し先）・skippedOther（リンク等で飛ばした）
//     ファイルは大きさに関わらず chunkBytes ずつ読んで探す（前の塊の終わりを、探す値の最長の形の長さ - 1 だけ重ねる）。
//     フォルダは日時で飛ばさない。中のファイルごとに mtime を見る。
// CLI:
//   node leak-scan.mjs --needles <file> --root <dir|file> [--root ..] --since <epoch_ms> [--max-bytes N]
//   needles のファイル: [{"name":"S","value":"..","id":"U（あれば）"}]
//   出力（JSON）: 見つけた場所（ファイル）・件数・形の名前・上の数だけ。値は出さない。
import * as fsReal from "node:fs";
import { readSync, closeSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 文字列 -> 小文字にした UTF-8 のバイト列を 1 バイト 1 字の文字列にした物。探す相手の側も同じ変換をする。
const fold = (s) => Buffer.from(s, "utf8").toString("latin1").toLowerCase();

const hex2 = (n) => n.toString(16).padStart(2, "0");
const codePoints = (s) => Array.from(s, (c) => c.codePointAt(0));

function b64(bytes, urlSafe) {
  let s = Buffer.from(bytes).toString("base64");
  if (urlSafe) s = s.replace(/\+/g, "-").replace(/\//g, "_");
  return s;
}

// base64 の「ずれに左右されない真ん中」。前に k バイト（0・1・2）付いた時、先頭から 3 バイトごとの区切りに
// 完全に収まる部分だけを取り、最後の端数は捨てる。
function b64Middles(bytes, urlSafe) {
  const out = [];
  for (let k = 0; k < 3; k++) {
    const start = k === 0 ? 0 : 3 - k;
    const rest = bytes.subarray(start);
    const whole = rest.subarray(0, Math.floor(rest.length / 3) * 3);
    if (whole.length === 0) continue;
    out.push(b64(whole, urlSafe));
  }
  return out;
}

export function buildForms(value, { id } = {}) {
  if (typeof value !== "string" || value.length === 0) throw new Error("value が空");
  const list = []; // {form, raw}（raw は変換前の文字列。後で fold する）
  const add = (form, s) => {
    if (typeof s === "string" && s.length > 0) list.push({ form, s });
  };

  // そのまま・逆順
  add("raw", value);
  add("reversed", Array.from(value).reverse().join(""));

  // URL
  const uri = encodeURIComponent(value);
  add("url", uri);
  add("url-form", uri.replace(/%20/g, "+"));
  add("url-form2", new URLSearchParams({ a: value }).toString().slice(2));
  add("url-uri", encodeURI(value));
  add("url-double", encodeURIComponent(uri));
  add("url-allbytes", Array.from(Buffer.from(value, "utf8"), (b) => "%" + hex2(b)).join(""));

  // JSON
  const json = JSON.stringify(value).slice(1, -1);
  add("json", json);
  add("json-unicode", Array.from(value, (c) => Array.from({ length: c.length }, (_, i) => "\\u" + c.charCodeAt(i).toString(16).padStart(4, "0")).join("")).join(""));
  add("json-ascii", json.replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")));
  add("json-slash", json.replace(/\//g, "\\/"));
  add("json-double", JSON.stringify(json).slice(1, -1));
  add(
    "json-double-unicode",
    JSON.stringify(Array.from(value, (c) => Array.from({ length: c.length }, (_, i) => "\\u" + c.charCodeAt(i).toString(16).padStart(4, "0")).join("")).join("")).slice(1, -1),
  );

  // HTML
  const html = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  add("html", html);
  add("html-apos", value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;"));
  add("html-dec", codePoints(value).map((n) => `&#${n};`).join(""));
  add("html-hex", codePoints(value).map((n) => `&#x${n.toString(16)};`).join(""));

  // base64（値・ID:値。普通の形と URL 用の形。前に 0・1・2 バイト付いた時の真ん中も）
  const sources = [Buffer.from(value, "utf8")];
  if (id) sources.push(Buffer.from(`${id}:${value}`, "utf8"));
  sources.forEach((bytes, si) => {
    const tag = si === 0 ? "b64" : "b64-id";
    for (const urlSafe of [false, true]) {
      const t = urlSafe ? `${tag}-url` : tag;
      const full = b64(bytes, urlSafe);
      add(`${t}-full`, full);
      add(`${t}-full`, full.replace(/=+$/, ""));
      for (const m of b64Middles(bytes, urlSafe)) if (m.length >= 8) add(`${t}-mid`, m);
    }
  });

  // 16 進（UTF-8 のバイト。大小文字は fold で同じになる）
  const bytes = Buffer.from(value, "utf8");
  add("hex", bytes.toString("hex"));
  add("hex-x", Array.from(bytes, (b) => "\\x" + hex2(b)).join(""));
  add("hex-spaced", Array.from(bytes, (b) => hex2(b)).join(" "));

  // UTF-16LE のままファイルに書かれた場合
  const u16 = Buffer.from(value, "utf16le").toString("latin1");
  list.push({ form: "utf16le", s: null, folded: u16.toLowerCase() });

  const seen = new Set();
  const out = [];
  for (const e of list) {
    const needle = e.folded ?? fold(e.s);
    if (needle.length === 0 || seen.has(needle)) continue;
    seen.add(needle);
    out.push({ form: e.form, needle });
  }
  return out;
}

// hay の中の needle の数（重ならない物）。終わりが skipEnd 以内の物は前の塊で数え済みなので数えない。
function countOccurrences(hay, needle, skipEnd = 0) {
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    i += needle.length;
    if (i > skipEnd) n++;
  }
  return n;
}

export function scanBuffer(buf, forms) {
  const hay = Buffer.isBuffer(buf) ? buf.toString("latin1").toLowerCase() : fold(String(buf));
  const counts = {};
  let total = 0;
  for (const { form, needle } of forms) {
    const c = countOccurrences(hay, needle);
    if (c > 0) {
      counts[form] = (counts[form] ?? 0) + c;
      total += c;
    }
  }
  return { total, forms: counts };
}

export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024; // これを超えるファイルは「探せなかった」に数える
export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const UNREADABLE_SAMPLES = 20;

// roots の下のファイルを探す。
//   ディレクトリの中: mtime が since より前のファイルは飛ばす（試験の前からある物。skippedOld に数える）。フォルダは日時で飛ばさない。
//   ファイルを直接渡した時は since を見ない。
//   大きさ: maxBytes 以下は全部、chunkBytes ずつ読んで探す。maxBytes を超える物は探せなかった物（skippedLarge）に数える。
// 戻り値に値は入れない。
export function scanTree({ roots, needles, since = 0, maxBytes = DEFAULT_MAX_BYTES, chunkBytes = DEFAULT_CHUNK_BYTES, io = {} }) {
  // io: 試験用に fs の呼び出しを差し替える口（読めない物を作るため）。普段は使わない
  const { openSync, readdirSync, lstatSync } = { ...fsReal, ...io };
  const prepared = needles.map((n) => ({ name: n.name, forms: buildForms(n.value, { id: n.id }) }));
  const maxLen = Math.max(1, ...prepared.flatMap((p) => p.forms.map((f) => f.needle.length)));
  const overlap = maxLen - 1;
  const chunk = Math.max(1, Math.floor(chunkBytes));
  const result = {
    scanned: 0,
    skippedOld: 0,
    skippedLarge: 0,
    skippedOther: 0,
    unreadable: 0,
    unreadableSamples: [],
    unreadableOldDirs: 0,
    unreadableOldDirSamples: [],
    missingRoots: [],
    hits: [],
    total: 0,
  };
  // 中を読めないフォルダのうち、フォルダ自身の更新日時（lstat の mtime）が since より古い物。判定不能にしない別の数。
  // フォルダの中に物を作る・消す・名前を変えると、そのフォルダの更新日時が変わる（NTFS も ext4 も）。
  // 日時が試験の前のままなら、試験の間に中へ新しい物は作られていない。
  // ただし中に前からあるファイルへの書き足しではフォルダの日時は変わらないので、それは見つけられない（README に書いた限界）。
  const unreadableOldDir = (p) => {
    result.unreadableOldDirs++;
    if (result.unreadableOldDirSamples.length < UNREADABLE_SAMPLES) result.unreadableOldDirSamples.push(p);
  };
  const unreadable = (p) => {
    result.unreadable++;
    if (result.unreadableSamples.length < UNREADABLE_SAMPLES) result.unreadableSamples.push(p);
  };

  const scanOne = (file) => {
    const counts = prepared.map(() => ({ total: 0, forms: {} }));
    let status = "ok";
    let fd = null;
    try {
      fd = openSync(file, "r");
      const buf = Buffer.allocUnsafe(chunk);
      let carry = "";
      let read = 0;
      for (;;) {
        const n = readSync(fd, buf, 0, chunk, null);
        if (n === 0) break;
        read += n;
        if (read > maxBytes) {
          status = "large";
          break;
        }
        const hay = carry + buf.latin1Slice(0, n).toLowerCase();
        prepared.forEach((p, i) => {
          for (const { form, needle } of p.forms) {
            const c = countOccurrences(hay, needle, carry.length);
            if (c > 0) {
              counts[i].forms[form] = (counts[i].forms[form] ?? 0) + c;
              counts[i].total += c;
            }
          }
        });
        carry = overlap > 0 ? hay.slice(Math.max(0, hay.length - overlap)) : "";
      }
    } catch {
      status = "unreadable";
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
    }
    if (status === "ok") result.scanned++;
    else if (status === "large") result.skippedLarge++;
    else unreadable(file);
    // 途中で止まっても、そこまでに見つけた分は残す
    prepared.forEach((p, i) => {
      if (counts[i].total > 0) {
        result.hits.push({ needle: p.name, file, count: counts[i].total, forms: counts[i].forms });
        result.total += counts[i].total;
      }
    });
  };

  const walk = (dir) => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      // lstat も失敗した物・更新日時が since 以降の物は、今までどおり「読めなかった」
      let old = false;
      try {
        old = lstatSync(dir).mtimeMs < since;
      } catch {}
      if (old) unreadableOldDir(dir);
      else unreadable(dir);
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        result.skippedOther++;
        continue;
      }
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.isFile()) {
        result.skippedOther++;
        continue;
      }
      let st;
      try {
        st = lstatSync(p);
      } catch {
        unreadable(p);
        continue;
      }
      if (st.mtimeMs < since) {
        result.skippedOld++;
        continue;
      }
      scanOne(p);
    }
  };
  for (const root of roots) {
    let st;
    try {
      st = statSync(root);
    } catch {
      result.missingRoots.push(root);
      continue;
    }
    if (st.isDirectory()) walk(root);
    else if (st.isFile()) scanOne(root);
    else result.skippedOther++;
  }
  return result;
}

function parseArgs(argv) {
  const a = { roots: [], since: 0, maxBytes: DEFAULT_MAX_BYTES, needles: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--needles") a.needles = argv[++i];
    else if (k === "--root") a.roots.push(argv[++i]);
    else if (k === "--since") a.since = Number(argv[++i]);
    else if (k === "--max-bytes") a.maxBytes = Number(argv[++i]);
    else throw new Error(`知らない引数: ${k}`);
  }
  if (!a.needles || a.roots.length === 0 || !Number.isFinite(a.since) || !Number.isFinite(a.maxBytes)) {
    throw new Error("使い方: leak-scan.mjs --needles <file> --root <dir> [--root ..] --since <epoch_ms> [--max-bytes N]");
  }
  return a;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = parseArgs(process.argv.slice(2));
    const needles = JSON.parse(readFileSync(a.needles, "utf8"));
    const r = scanTree({ roots: a.roots, needles, since: a.since, maxBytes: a.maxBytes });
    process.stdout.write(JSON.stringify({ ok: true, roots: a.roots, since: a.since, ...r }) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 200) }) + "\n");
    process.exit(2);
  }
}
