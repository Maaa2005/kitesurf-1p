// 返事と記録の中を、値と形を変えた値で探す。見つかったかどうか（真偽）だけを返し、値そのものは返さない。
// 大小文字は区別しない（探す文字も探される文字も小文字にそろえる）。

export const MIN_NEEDLE = 4; // これより短い値は探せない（入れない）

const hex2 = (n) => n.toString(16).padStart(2, "0");

function reverseByCodePoint(s) {
  return Array.from(s).reverse().join("");
}

function htmlNamed(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function htmlDec(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`);
}
function htmlHex(s) {
  return s.replace(/[&<>"']/g, (c) => `&#x${c.codePointAt(0).toString(16)};`);
}
function htmlApos(s) {
  return htmlNamed(s).replace(/&#39;/g, "&apos;");
}
function htmlAllDec(s) {
  return Array.from(s, (c) => `&#${c.codePointAt(0)};`).join("");
}
function htmlAllHex(s) {
  return Array.from(s, (c) => `&#x${c.codePointAt(0).toString(16)};`).join("");
}

function jsonEscapedAll(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) out += "\\u" + s.charCodeAt(i).toString(16).padStart(4, "0");
  return out;
}

function percentAllBytes(bytes) {
  let out = "";
  for (const b of bytes) out += `%${hex2(b)}`;
  return out;
}

// 前に k バイト付けた時にずれに左右されずに残る base64 の真ん中の部分（標準と URL 用）。
function base64Stable(bytes) {
  const out = [];
  for (let k = 0; k < 3; k++) {
    const std = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64").replace(/=+$/, "");
    const from = Math.ceil((8 * k) / 6);
    const to = Math.floor((8 * (k + bytes.length)) / 6);
    const mid = std.slice(from, to);
    out.push(mid, mid.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  // 付け足しの無い完全な形（= 付き・無し）も入れる
  const full = bytes.toString("base64");
  out.push(full, full.replace(/=+$/, ""), full.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  return out;
}

// 1 つの値から、探す文字（小文字）の一覧を作る。
export function buildNeedles(value, id = "") {
  if (typeof value !== "string" || value.length === 0) return [];
  const bytes = Buffer.from(value, "utf8");
  const forms = [];
  const add = (s) => {
    if (typeof s === "string" && s.length >= MIN_NEEDLE) forms.push(s);
  };

  // そのまま・逆順
  add(value);
  add(reverseByCodePoint(value));

  // URL
  const enc = encodeURIComponent(value);
  add(enc);
  add(enc.replace(/%20/g, "+"));
  add(new URLSearchParams({ a: value }).toString().slice(2));
  add(encodeURI(value));
  add(percentAllBytes(bytes));
  try {
    add(escape(value));
  } catch {}

  // JSON
  const j = JSON.stringify(value).slice(1, -1);
  add(j);
  add(j.replace(/\//g, "\\/"));
  add(jsonEscapedAll(value));

  // HTML
  add(htmlNamed(value));
  add(htmlDec(value));
  add(htmlHex(value));
  add(htmlApos(value));
  add(htmlAllDec(value));
  add(htmlAllHex(value));

  // base64（値・ID:値）
  for (const b of base64Stable(bytes)) add(b);
  if (id) {
    const withId = Buffer.from(`${id}:${value}`, "utf8");
    for (const b of base64Stable(withId)) add(b);
  }

  // 16 進（UTF-8 のバイト）
  add(bytes.toString("hex"));

  // 返事全体を JSON にした時に、各形がもう一段エスケープされる分も入れる
  const all = [...forms];
  for (const f of forms) add2(all, JSON.stringify(f).slice(1, -1));
  return [...new Set(all.map((f) => f.toLowerCase()))];
}

function add2(list, s) {
  if (s.length >= MIN_NEEDLE) list.push(s);
}

export class LeakGuard {
  #store;
  #cache = new Map();

  constructor(store) {
    this.#store = store;
  }

  #needles() {
    const entries = this.#store.entries();
    const live = new Set();
    const out = [];
    for (const { value, id } of entries) {
      const key = `${id}\u0000${value}`;
      live.add(key);
      let n = this.#cache.get(key);
      if (!n) {
        n = buildNeedles(value, id);
        this.#cache.set(key, n);
      }
      out.push(...n);
    }
    for (const k of [...this.#cache.keys()]) if (!live.has(k)) this.#cache.delete(k);
    return out;
  }

  // 文字（または文字の並び・JSON にできる物）の中に、保護した値の形が 1 つでもあれば true。
  hasLeak(...parts) {
    const needles = this.#needles();
    if (needles.length === 0) return false;
    const texts = [];
    for (const p of parts) {
      if (p === undefined || p === null) continue;
      if (typeof p === "string") texts.push(p);
      else {
        try {
          texts.push(JSON.stringify(p));
        } catch {
          texts.push(String(p));
        }
      }
    }
    for (const t of texts) {
      const low = t.toLowerCase();
      for (const n of needles) if (low.includes(n)) return true;
    }
    return false;
  }
}
