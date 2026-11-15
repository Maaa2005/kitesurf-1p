import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, openSync as fsOpen, readdirSync as fsReaddir, lstatSync as fsLstat } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildForms, scanBuffer, scanTree } from "../lib/leak-scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "lib", "leak-scan.mjs");

// 合成の値: 英数字・記号（引用符・& < > を含む）・日本語・絵文字
const VALUE = `Ab3x"Q&p<9>'k/\\#パスワ🔑z7Y`;
const ID = "user-Zq83mK2p";

const hits = (hay, opts = {}) => scanBuffer(Buffer.isBuffer(hay) ? hay : Buffer.from(String(hay), "utf8"), buildForms(VALUE, { id: ID, ...opts }));
const found = (hay) => hits(hay).total > 0;

test("そのまま", () => {
  assert.ok(found(`xx ${VALUE} yy`));
  assert.ok(hits(`xx ${VALUE} yy`).forms.raw >= 1);
});

test("大小文字を区別しない", () => {
  assert.ok(found(VALUE.toUpperCase()));
  assert.ok(found(VALUE.toLowerCase()));
});

test("逆順", () => {
  assert.ok(hits(Array.from(VALUE).reverse().join("")).forms.reversed >= 1);
});

test("URL: %XX（大文字・小文字）・+・二重", () => {
  const enc = encodeURIComponent(VALUE);
  assert.ok(hits(`a=${enc}&b=1`).forms.url >= 1);
  assert.ok(found(enc.toLowerCase()));
  const form = enc.replace(/%20/g, "+");
  assert.ok(found(form));
  assert.ok(hits(encodeURIComponent(enc)).forms["url-double"] >= 1);
  // 空白の入る値は + の形でも見つかる
  const sp = buildForms("pass word 12345", {});
  assert.ok(scanBuffer(Buffer.from("x=pass+word+12345&y"), sp).total > 0);
  assert.ok(scanBuffer(Buffer.from("x=pass%20word%2012345&y"), sp).total > 0);
});

test("JSON: \\\" と \\uXXXX", () => {
  assert.ok(hits(JSON.stringify({ p: VALUE })).forms.json >= 1);
  const allU = Array.from(VALUE, (c) => Array.from({ length: c.length }, (_, i) => "\\u" + c.charCodeAt(i).toString(16).padStart(4, "0")).join("")).join("");
  assert.ok(hits(`{"p":"${allU}"}`).forms["json-unicode"] >= 1);
  assert.ok(found(`{"p":"${allU.toUpperCase().replace(/\\U/g, "\\u")}"}`));
  // JSON の中の JSON（二重に逃がした形）
  assert.ok(hits(JSON.stringify(JSON.stringify({ p: VALUE }))).total > 0);
});

test("HTML: 名前の形・&#NN;・&#xHH;", () => {
  const named = VALUE.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  assert.ok(hits(`<p>${named}</p>`).forms.html >= 1);
  const dec = Array.from(VALUE, (c) => `&#${c.codePointAt(0)};`).join("");
  assert.ok(hits(`<p>${dec}</p>`).forms["html-dec"] >= 1);
  const hex = Array.from(VALUE, (c) => `&#x${c.codePointAt(0).toString(16).toUpperCase()};`).join("");
  assert.ok(hits(`<p>${hex}</p>`).forms["html-hex"] >= 1);
});

test("base64: 値・ID:値・URL 用・0/1/2 バイトずれ", () => {
  const std = (b) => Buffer.from(b).toString("base64");
  const urlSafe = (b) => std(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const v = Buffer.from(VALUE, "utf8");
  const iv = Buffer.from(`${ID}:${VALUE}`, "utf8");
  assert.ok(found(std(v)));
  assert.ok(found(urlSafe(v)));
  assert.ok(found(std(iv)));
  assert.ok(found(urlSafe(iv)));
  for (const k of [0, 1, 2]) {
    for (const src of [v, iv]) {
      const pre = Buffer.alloc(k, 0x41);
      const post = Buffer.from("tail-bytes-xyz");
      const wrapped = Buffer.concat([pre, src, post]);
      assert.ok(found(std(wrapped)), `ずれ ${k} の標準`);
      assert.ok(found(urlSafe(wrapped)), `ずれ ${k} の URL 用`);
    }
  }
  // HTTP の Basic の形
  assert.ok(found(`Authorization: Basic ${std(iv)}`));
});

test("16 進（小文字・大文字）", () => {
  const hex = Buffer.from(VALUE, "utf8").toString("hex");
  assert.ok(hits(hex).forms.hex >= 1);
  assert.ok(found(hex.toUpperCase()));
});

test("UTF-16LE のファイル", () => {
  assert.ok(found(Buffer.from(`x${VALUE}y`, "utf16le")));
});

test("件数を数える", () => {
  assert.equal(hits(`${VALUE} ${VALUE} ${VALUE}`).forms.raw, 3);
});

test("関係ない文字では見つけない", () => {
  const noise = [
    "",
    "hello world, this is a log line with nothing secret.",
    JSON.stringify({ url: "http://127.0.0.1:9921/login-post", title: "ログイン", text: "ユーザー名 パスワード" }),
    "[1] textbox \"パスワード\" value=\"(入力済み)\"",
    Buffer.from("0123456789abcdef".repeat(100)).toString("base64"),
    Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7919) % 251)).toString("hex"),
    "Ab3x Q p 9 k z7Y パスワ 🔑", // 値の一部だけ（記号と区切りが違う）
    ID.slice(0, 8),
  ];
  for (const n of noise) assert.equal(hits(n).total, 0, `誤検出: ${String(n).slice(0, 40)}`);
});

test("値が違えば見つけない（別の値の形も拾わない）", () => {
  const other = `Zz9y"Q&p<9>'k/\\#パスワ🔑z7Y`;
  assert.equal(hits(other).total, 0);
  assert.equal(hits(encodeURIComponent(other)).total, 0);
  assert.equal(hits(Buffer.from(other).toString("base64")).total, 0);
});

test("ID だけは見つけない（照合に使うのは値の形）", () => {
  assert.equal(hits(`name=${ID}`).total, 0);
});

test("scanTree: 日時と大きさの絞り込み・値を結果に入れない", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ks1p-scan-"));
  try {
    const old = path.join(dir, "old.txt");
    const fresh = path.join(dir, "fresh.txt");
    const big = path.join(dir, "big.txt");
    const clean = path.join(dir, "clean.txt");
    writeFileSync(old, VALUE);
    utimesSync(old, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    writeFileSync(fresh, `a ${encodeURIComponent(VALUE)} b`);
    writeFileSync(big, VALUE + "x".repeat(2000));
    writeFileSync(clean, "nothing");
    const r = scanTree({ roots: [dir], needles: [{ name: "S", value: VALUE, id: ID }], since: Date.now() - 60_000, maxBytes: 1000 });
    assert.deepEqual(r.hits.map((h) => path.basename(h.file)), ["fresh.txt"]);
    assert.equal(r.skippedOld, 1);
    assert.equal(r.skippedLarge, 1);
    assert.equal(r.total, 1);
    assert.ok(!JSON.stringify(r).includes(VALUE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: 場所と件数だけを JSON で出す", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ks1p-scan-cli-"));
  try {
    writeFileSync(path.join(dir, "a.log"), `x ${VALUE} y ${Buffer.from(VALUE).toString("hex")}`);
    // needles のファイルは探す場所の外に置く
    const ndir = mkdtempSync(path.join(tmpdir(), "ks1p-scan-needles-"));
    const nf = path.join(ndir, "needles.json");
    writeFileSync(nf, JSON.stringify([{ name: "S", value: VALUE, id: ID }]));
    const p = spawnSync(process.execPath, [CLI, "--needles", nf, "--root", dir, "--since", "0"], { encoding: "utf8" });
    assert.equal(p.status, 0);
    const out = JSON.parse(p.stdout);
    assert.equal(out.ok, true);
    const aHit = out.hits.find((h) => h.file.endsWith("a.log"));
    assert.equal(aHit.count, 2);
    assert.ok(!p.stdout.includes(VALUE));
    assert.ok(!p.stdout.includes(Buffer.from(VALUE).toString("hex")));
    rmSync(ndir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NEEDLES = [{ name: "S", value: VALUE, id: ID }];

test("scanTree: フォルダは日時で飛ばさない（古いフォルダの中の新しいファイルも探す・古いファイルは数えて飛ばす）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ks1p-scan-dirs-"));
  try {
    mkdirSync(path.join(dir, "olddir"));
    mkdirSync(path.join(dir, "newdir"));
    writeFileSync(path.join(dir, "olddir", "fresh-in-old.txt"), VALUE);
    writeFileSync(path.join(dir, "olddir", "stale-in-old.txt"), VALUE);
    writeFileSync(path.join(dir, "newdir", "stale-in-new.txt"), VALUE);
    writeFileSync(path.join(dir, "newdir", "fresh-in-new.txt"), VALUE);
    const past = new Date(Date.now() - 3600_000);
    utimesSync(path.join(dir, "olddir", "stale-in-old.txt"), past, past);
    utimesSync(path.join(dir, "newdir", "stale-in-new.txt"), past, past);
    // フォルダの更新は最後に古くする（中のファイルを上書きしてもフォルダの更新時刻は変わらない状況）
    utimesSync(path.join(dir, "olddir"), past, past);
    const r = scanTree({ roots: [dir], needles: NEEDLES, since: Date.now() - 60_000 });
    assert.deepEqual(r.hits.map((h) => path.basename(h.file)).sort(), ["fresh-in-new.txt", "fresh-in-old.txt"]);
    assert.equal(r.skippedOld, 2);
    assert.equal(r.scanned, 2);
    assert.equal(r.unreadable, 0);
    assert.deepEqual(r.missingRoots, []);
    const r2 = scanTree({ roots: [dir], needles: NEEDLES, since: 0 });
    assert.equal(r2.hits.length, 4);
    assert.equal(r2.skippedOld, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanTree: 大きいファイルも少しずつ読んで探し、塊の切れ目にまたがる値も 1 回だけ数える", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ks1p-scan-chunk-"));
  try {
    const forms = buildForms(VALUE, { id: ID });
    const maxLen = Math.max(...forms.map((f) => f.needle.length));
    const rawLen = Buffer.byteLength(VALUE, "utf8");
    const chunk = maxLen + 50; // 最長の形より少し大きい塊
    // 値の置き場所を、塊の切れ目の前後で 1 バイトずつずらす（値が切れ目の手前で終わる・切れ目をまたぐ・切れ目の直後から始まる）
    for (let start = chunk - rawLen - 2; start <= chunk + 2; start++) {
      const f = path.join(dir, `raw-${start}.bin`);
      writeFileSync(f, Buffer.concat([Buffer.alloc(start, 0x2e), Buffer.from(VALUE, "utf8"), Buffer.alloc(chunk * 3, 0x2e)]));
      const r = scanTree({ roots: [f], needles: NEEDLES, chunkBytes: chunk });
      assert.equal(r.total, 1, `位置 ${start}: ちょうど 1 件（見落としも二重も無い）`);
      assert.equal(r.scanned, 1);
      assert.equal(r.skippedLarge, 0);
    }
    // いちばん長い形（探す形のうち最長）も、切れ目をまたいで見つかる
    const longest = forms.reduce((a, b) => (b.needle.length > a.needle.length ? b : a));
    for (const start of [chunk - maxLen + 1, chunk - Math.floor(maxLen / 2), chunk - 1]) {
      const f = path.join(dir, `long-${start}.bin`);
      writeFileSync(f, Buffer.concat([Buffer.alloc(start, 0x2e), Buffer.from(longest.needle, "latin1"), Buffer.alloc(chunk * 3, 0x2e)]));
      const r = scanTree({ roots: [f], needles: NEEDLES, chunkBytes: chunk });
      assert.equal(r.total, 1, `最長の形 位置 ${start}`);
      assert.equal(r.hits[0].forms[longest.form], 1);
    }
    // 塊の大きさより十分大きいファイル（数十の塊）に散らした値を全部数える
    const parts = [];
    for (let i = 0; i < 40; i++) parts.push(Buffer.alloc(100 + i * 37, 0x2e), Buffer.from(i % 2 ? encodeURIComponent(VALUE) : VALUE));
    const big = path.join(dir, "big.bin");
    writeFileSync(big, Buffer.concat(parts));
    const rb = scanTree({ roots: [dir], needles: NEEDLES, chunkBytes: 97 });
    const bigHit = rb.hits.find((h) => path.basename(h.file) === "big.bin");
    assert.equal(bigHit.count, 40);
    // 大きさの上限以下なら、塊より大きくても探せなかった物に数えない
    const size = Buffer.concat(parts).length;
    const rOk = scanTree({ roots: [big], needles: NEEDLES, chunkBytes: 97, maxBytes: size });
    assert.equal(rOk.skippedLarge, 0);
    assert.equal(rOk.total, 40);
    // 上限を超えた物は「探せなかった」に数える（探した数には入れない）
    const rOver = scanTree({ roots: [big], needles: NEEDLES, chunkBytes: 97, maxBytes: size - 1 });
    assert.equal(rOver.skippedLarge, 1);
    assert.equal(rOver.scanned, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanTree: 読めない物と無い探し先を数える（無い探し先はその名前を返す）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ks1p-scan-unread-"));
  try {
    mkdirSync(path.join(dir, "sub"));
    mkdirSync(path.join(dir, "noaccess"));
    writeFileSync(path.join(dir, "ok.txt"), `x ${VALUE}`);
    writeFileSync(path.join(dir, "locked.txt"), VALUE);
    writeFileSync(path.join(dir, "sub", "locked2.txt"), VALUE);
    const missing = path.join(dir, "no-such-dir");
    const io = {
      openSync(p, ...rest) {
        if (path.basename(p).startsWith("locked")) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        return fsOpen(p, ...rest);
      },
      readdirSync(p, ...rest) {
        if (path.basename(p) === "noaccess") throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        return fsReaddir(p, ...rest);
      },
    };
    const r = scanTree({ roots: [dir, missing], needles: NEEDLES, io });
    assert.equal(r.scanned, 1);
    assert.equal(r.unreadable, 3, "ファイル 2 つとフォルダ 1 つ");
    assert.deepEqual(r.missingRoots, [missing]);
    assert.equal(r.total, 1, "読めた物の分は数える");
    assert.deepEqual(r.hits.map((h) => path.basename(h.file)), ["ok.txt"]);
    assert.equal(r.unreadableSamples.length, 3);
    assert.ok(!JSON.stringify(r).includes(VALUE));
    // 何も欠けていなければ 0
    const clean = scanTree({ roots: [path.join(dir, "sub")], needles: [{ name: "Z", value: "zzz-not-there-123" }] });
    assert.equal(clean.unreadable, 0);
    assert.deepEqual(clean.missingRoots, []);
    assert.equal(clean.scanned, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanTree: 中を読めないフォルダは、自身の日時が古ければ別に数え（判定不能にしない）、新しければ読めなかった物に数える", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ks1p-scan-olddir-"));
  try {
    mkdirSync(path.join(dir, "old-parent"));
    mkdirSync(path.join(dir, "old-parent", "denied-old"));
    mkdirSync(path.join(dir, "denied-new"));
    mkdirSync(path.join(dir, "denied-nostat"));
    writeFileSync(path.join(dir, "ok.txt"), "nothing");
    writeFileSync(path.join(dir, "locked.txt"), "nothing");
    const past = new Date(Date.now() - 9 * 24 * 3600_000);
    utimesSync(path.join(dir, "old-parent", "denied-old"), past, past);
    const since = Date.now() - 60_000;
    const needles = [{ name: "Z", value: "zzz-not-there-123" }];
    const eperm = () => Object.assign(new Error("EPERM"), { code: "EPERM" });
    const base = {
      readdirSync(p, ...rest) {
        if (path.basename(p).startsWith("denied")) throw eperm();
        return fsReaddir(p, ...rest);
      },
    };
    // 古い日時の読めないフォルダだけ: 判定不能（unreadable）にならず、別に数える
    const r1 = scanTree({ roots: [path.join(dir, "old-parent")], needles, since, io: base });
    assert.equal(r1.unreadable, 0);
    assert.equal(r1.unreadableOldDirs, 1);
    assert.deepEqual(r1.unreadableOldDirSamples.map((p) => path.basename(p)), ["denied-old"]);
    // 新しい日時の読めないフォルダ・読めないファイル・lstat も失敗した読めないフォルダは、今までどおり読めなかった
    const io = {
      ...base,
      openSync(p, ...rest) {
        if (path.basename(p) === "locked.txt") throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        return fsOpen(p, ...rest);
      },
      lstatSync(p, ...rest) {
        if (path.basename(p) === "denied-nostat") throw eperm();
        return fsLstat(p, ...rest);
      },
    };
    const r2 = scanTree({ roots: [dir], needles, since, io });
    assert.equal(r2.unreadableOldDirs, 1, "denied-old だけ");
    assert.equal(r2.unreadable, 3, "denied-new・denied-nostat・locked.txt");
    assert.deepEqual(r2.unreadableSamples.map((p) => path.basename(p)).sort(), ["denied-new", "denied-nostat", "locked.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanTree: 結果にも CLI の出力にも値（と、その形を変えた物）を入れない", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ks1p-scan-noval-"));
  const ndir = mkdtempSync(path.join(tmpdir(), "ks1p-scan-noval-needles-"));
  try {
    const shapes = (v) => [v, encodeURIComponent(v), Buffer.from(v).toString("hex"), Buffer.from(v).toString("base64"), JSON.stringify(v).slice(1, -1), Array.from(v).reverse().join("")];
    writeFileSync(path.join(dir, "a.txt"), [VALUE, encodeURIComponent(VALUE), Buffer.from(VALUE).toString("hex"), Buffer.from(`${ID}:${VALUE}`).toString("base64")].join("\n"));
    writeFileSync(path.join(dir, "locked.txt"), VALUE);
    const io = {
      openSync(p, ...rest) {
        if (path.basename(p) === "locked.txt") throw new Error(`cannot open ${VALUE}`); // 例外の文面に値が混ざっても結果へは出さない
        return fsOpen(p, ...rest);
      },
    };
    const r = scanTree({ roots: [dir, path.join(dir, "missing")], needles: NEEDLES, io });
    assert.ok(r.total >= 4);
    const text = JSON.stringify(r);
    for (const s of shapes(VALUE)) assert.ok(!text.includes(s), `結果に値の形が入っている: ${s.slice(0, 10)}`);
    // CLI
    const nf = path.join(ndir, "needles.json");
    writeFileSync(nf, JSON.stringify(NEEDLES));
    const p = spawnSync(process.execPath, [CLI, "--needles", nf, "--root", dir, "--root", path.join(dir, "missing"), "--since", "0"], { encoding: "utf8" });
    assert.equal(p.status, 0);
    const out = JSON.parse(p.stdout);
    for (const k of ["scanned", "skippedOld", "skippedLarge", "unreadable"]) assert.equal(typeof out[k], "number", k);
    assert.deepEqual(out.missingRoots, [path.join(dir, "missing")]);
    for (const s of shapes(VALUE)) assert.ok(!p.stdout.includes(s), `CLI の出力に値の形が入っている: ${s.slice(0, 10)}`);
    // 古い --prune-old-dirs は受け付けない（フォルダを日時で飛ばす物は無い）
    const old = spawnSync(process.execPath, [CLI, "--needles", nf, "--root", dir, "--since", "0", "--prune-old-dirs"], { encoding: "utf8" });
    assert.equal(old.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(ndir, { recursive: true, force: true });
  }
});
