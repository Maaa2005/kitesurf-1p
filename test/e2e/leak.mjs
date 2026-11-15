// 漏れ試験（設計書 5 節・実装仕様「試験の一覧」）。T1〜T4・T8〜T11。T5〜T7 は欠番。
//   npm run test:leak             1 回
//   npm run test:leak -- --runs 3 新しい値で 3 回（T11）
// 前提: Kitesurf が scripts/kitesurf-dev.sh で動いている（ws://127.0.0.1:8787・記録は KS_LOG、既定 $HOME/dev/kitesurf-dev.log）。
//   番号を変える時は Kitesurf 側 KITESURF_PORT と、こちらの KS1P_KITESURF_WS をそろえる（健康確認も KS1P_KITESURF_WS の host:port を使う）。
// 値は全部合成。結果は test/.run/<run>/report.json（値を書かない）と画面の表。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, startTestSite, SITE_A, SITE_B, REPO_ROOT } from "../lib/mcp-client.mjs";
import { buildForms, scanBuffer, scanTree, DEFAULT_MAX_BYTES } from "../lib/leak-scan.mjs";
import { ocrCheck } from "../lib/ocr.mjs";
import { winToWsl, wslArgs, kitesurfPaths } from "../lib/wsl.mjs";
import { kitesurfHealthUrl } from "../lib/kitesurf.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_BASE = path.join(REPO_ROOT, "test", ".run");
const FAKE_OP = path.join(REPO_ROOT, "test", "fake-op.mjs");
const SCAN_CLI_WSL = winToWsl(path.join(REPO_ROOT, "test", "lib", "leak-scan.mjs"));
// Kitesurf の置き場と記録（scripts/kitesurf-dev.sh と同じ既定。環境変数 KITESURF_DIR・KS_LOG）
const { log: KITESURF_LOG, wrangler: WRANGLER } = kitesurfPaths();
const BIG_HEADING = "BIGLOGINPAGE";
const BIG_BYTES = 200 * 1024 * 1024;

// ------------------------------------------------------------ 値
const pick = (s) => {
  const a = Array.from(s);
  return a[randomInt(a.length)];
};
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const SYMS = "!#$%&*+-=?@^_~\"'<>/\\";
const JP = "あいうえおかきくけこさしすせそ漢字試験秘密合言葉テストパスワード";
const EMOJI = ["🔑", "🪁", "🌊", "🏄", "🔒"];
const OCR_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rep = (n, f) => Array.from({ length: n }, f);

// パスワード: 24 字・記号 3 字以上・日本語 3 字以上・絵文字 1 字
function genPassword() {
  const chars = [...rep(4, () => pick(SYMS)), ...rep(4, () => pick(JP)), pick(EMOJI.join("")), ...rep(15, () => pick(ALNUM))];
  return shuffle(chars).join("");
}
const genUser = () => "user-" + rep(8, () => pick(ALNUM)).join("");
const genOcr = () => rep(16, () => pick(OCR_ALPHA)).join("");
function genSet() {
  return { S: genPassword(), U: genUser(), Socr: genOcr(), Cai: genOcr(), Cctl: genPassword() };
}

// ------------------------------------------------------------ 道具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wsl = (...a) => wslArgs(...a);

function runWsl(args, { input = null, timeoutMs = 120000, binary = false } = {}) {
  return new Promise((resolve) => {
    const c = spawn("wsl.exe", wsl(...args), { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    c.stdout.on("data", (d) => out.push(d));
    c.stderr.on("data", (d) => err.push(d));
    const t = setTimeout(() => c.kill(), timeoutMs);
    c.on("close", (code) => {
      clearTimeout(t);
      const o = Buffer.concat(out);
      resolve({ code, out: binary ? o : o.toString("utf8"), err: Buffer.concat(err).toString("utf8") });
    });
    c.on("error", () => {
      clearTimeout(t);
      resolve({ code: -1, out: binary ? Buffer.alloc(0) : "", err: "spawn error" });
    });
    if (input !== null) c.stdin.end(input);
    else c.stdin.end();
  });
}

async function kitesurfHealthy() {
  try {
    const r = await fetch(kitesurfHealthUrl(), { signal: AbortSignal.timeout(5000) });
    return (await r.text()).includes("kitesurf: OK");
  } catch {
    return false;
  }
}

// 大きさ。取れなかった時は null（stat の失敗・数でない返事）
async function kitesurfLogSizeOrNull() {
  const r = await runWsl(["stat", "-c", "%s", KITESURF_LOG]);
  if (r.code !== 0) return null;
  const s = String(r.out).trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

// 開始時の位置。取れなかった時は 0（最初から全部写す＝探す範囲が広がるだけで、緩くはならない）
async function kitesurfLogSize() {
  return (await kitesurfLogSizeOrNull()) ?? 0;
}

// 試験開始後の分だけを dest に写す。
// stat・tail が失敗した時は空のファイルを書かず、{ ok: false, error } を返す（呼んだ側が「判定不能」にする）。
async function copyKitesurfLog(dest, offset) {
  const size = await kitesurfLogSizeOrNull();
  if (size === null) return { ok: false, error: "Kitesurf の記録の大きさを取れなかった（stat の失敗）" };
  const from = size < offset ? 0 : offset; // 作り直されていたら最初から
  const r = await runWsl(["tail", "-c", `+${from + 1}`, KITESURF_LOG], { binary: true, timeoutMs: 60000 });
  if (r.code !== 0) return { ok: false, error: `Kitesurf の記録を写せなかった（tail の終了コード ${r.code}）` };
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, r.out);
  return { ok: true, bytes: r.out.length };
}

const countLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0);

function makeItem(title, url, user, pass) {
  return {
    id: "fakeid",
    title,
    category: "LOGIN",
    urls: [{ primary: true, href: url }],
    fields: [
      { id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: user },
      { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: pass },
    ],
  };
}

// 値を含まない応答の探し方（応答の文字を形を変えた値で探す）
function makeScanner(needles) {
  const prepared = needles.map((n) => ({ name: n.name, forms: buildForms(n.value, { id: n.id }) }));
  return (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");
    let total = 0;
    for (const p of prepared) total += scanBuffer(buf, p.forms).total;
    return total;
  };
}

// 場所ごとの数: scanned=探した・skippedOld=古くて飛ばした・skippedLarge=大きすぎて探せなかった（上限超え）・
// unreadable=読めなかった（判定不能になる）・unreadableOldDirs=中を読めないが自身の更新日時が試験の前の古いフォルダ（判定不能にしない）・missingRoots=無かった探し先（skippedOther=リンク等で飛ばした）
function summarize(res) {
  return {
    total: res.total,
    scanned: res.scanned,
    skippedOld: res.skippedOld,
    skippedLarge: res.skippedLarge,
    unreadable: res.unreadable,
    unreadableSamples: res.unreadableSamples ?? [],
    unreadableOldDirs: res.unreadableOldDirs ?? 0,
    unreadableOldDirSamples: res.unreadableOldDirSamples ?? [],
    missingRoots: res.missingRoots,
    skippedOther: res.skippedOther ?? 0,
    hits: res.hits.map((h) => ({ needle: h.needle, file: h.file, count: h.count, forms: h.forms })),
  };
}

async function wslScan(roots, needlesFile, since) {
  const args = ["node", SCAN_CLI_WSL, "--needles", winToWsl(needlesFile)];
  for (const r of roots) args.push("--root", r);
  args.push("--since", String(since), "--max-bytes", String(DEFAULT_MAX_BYTES));
  const r = await runWsl(args, { timeoutMs: 180000 });
  try {
    const j = JSON.parse(r.out.trim().split("\n").pop());
    if (!j.ok) return { ok: false, error: j.error };
    return { ok: true, ...summarize(j) };
  } catch {
    return { ok: false, error: `WSL の漏れ探しの返事を読めない (code ${r.code})` };
  }
}

function localScan(roots, needles, since, maxBytes = DEFAULT_MAX_BYTES) {
  try {
    return { ok: true, ...summarize(scanTree({ roots, needles, since, maxBytes })) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}

// 「0 件」を合格にしてよいかの確かめ。探せなかった物があれば理由の一覧を返す（空なら判定できる）。
//   読めなかった・上限超えで探せなかった物が 1 つでもあれば判定不能。
//   mustExist: 無いと判定不能になる探し先（有るはずの物）。それ以外の探し先は、無ければ「何も書かれなかった」正しい場合として許す。
//   探したファイルが 0 も判定不能（無くてよい探し先だけが無かった時を除く）。
function inconclusiveReasons(res, mustExist = [], roots = mustExist) {
  if (!res?.ok) return ["探せない"];
  const why = [];
  if (res.copyFailed) why.push(`記録を写せなかった（${res.copyFailed}）`);
  if (res.unreadable > 0) why.push(`読めなかった ${res.unreadable}`);
  if (res.skippedLarge > 0) why.push(`上限超えで探せなかった ${res.skippedLarge}`);
  const missing = res.missingRoots ?? [];
  const lost = missing.filter((r) => mustExist.includes(r));
  if (lost.length > 0) why.push(`有るはずの探し先が無い ${lost.length}`);
  // 探し先が全部「無くてよい物」で、全部無かった時だけ、探したファイルが 0 でもよい
  const onlyOptionalMissing = roots.length > 0 && missing.length === roots.length && lost.length === 0;
  if (res.scanned === 0 && lost.length === 0 && !onlyOptionalMissing) why.push("探したファイルが 0");
  return why;
}

// ------------------------------------------------------------ 1 回分の文脈
function makeCtx(runIdx, site, stamp) {
  const runId = `${stamp}-r${runIdx}`;
  const dir = path.join(RUN_BASE, runId);
  const d = {
    run: dir,
    secret: path.join(dir, "secret"),
    scan: path.join(dir, "scan"),
    shots: path.join(dir, "shots"),
  };
  for (const p of Object.values(d)) mkdirSync(p, { recursive: true });
  const vals = { prod: genSet(), ctrl: genSet() };
  const ctx = { runId, runIdx, site, dirs: d, vals, startedAt: Date.now(), placed: [], controls: {}, kitesurfOffset: 0, gates: {} };

  // 偽の op の項目・サイト一覧（値を含む物は secret/ に置く）
  const sitesFile = path.join(d.secret, "sites.json");
  writeFileSync(
    sitesFile,
    JSON.stringify([
      { name: "test-a", origin: SITE_A, op: { item: "item-a" } },
      { name: "test-ocr", origin: SITE_A, op: { item: "item-ocr" } },
      { name: "test-itemb", origin: SITE_A, op: { item: "item-b" } },
    ]),
  );
  ctx.sitesFile = sitesFile;
  for (const kind of ["prod", "ctrl", "https"]) {
    const v = kind === "ctrl" ? vals.ctrl : vals.prod;
    const opDir = path.join(d.secret, `op-${kind}`);
    mkdirSync(opDir, { recursive: true });
    writeFileSync(
      path.join(opDir, "items.json"),
      JSON.stringify({
        "item-a": makeItem("item-a", SITE_A, v.U, v.S),
        "item-ocr": makeItem("item-ocr", SITE_A, v.U, v.Socr),
        "item-b": makeItem("item-b", SITE_B, v.U, v.S),
      }),
    );
    writeFileSync(path.join(opDir, "behavior.json"), JSON.stringify({ mode: "ok", delayMs: 0 }));
  }
  // 探す物（WSL の漏れ探しに渡す）
  const needlesOf = (v) => [
    { name: "S", value: v.S, id: v.U },
    { name: "Socr", value: v.Socr, id: v.U },
  ];
  ctx.needlesProd = needlesOf(vals.prod);
  ctx.needlesCtrl = [...needlesOf(vals.ctrl), { name: "Cai", value: vals.ctrl.Cai }];
  ctx.needlesCtl = [{ name: "Cctl", value: vals.ctrl.Cctl, id: "ctl-user" }];
  ctx.needlesFile = {
    prod: path.join(d.secret, "needles-prod.json"),
    ctrl: path.join(d.secret, "needles-ctrl.json"),
    ctl: path.join(d.secret, "needles-ctl.json"),
  };
  writeFileSync(ctx.needlesFile.prod, JSON.stringify(ctx.needlesProd));
  writeFileSync(ctx.needlesFile.ctrl, JSON.stringify(ctx.needlesCtrl));
  writeFileSync(ctx.needlesFile.ctl, JSON.stringify(ctx.needlesCtl));
  return ctx;
}

const opDirOf = (ctx, kind) => path.join(ctx.dirs.secret, `op-${kind}`);
const callsOf = (ctx, kind) => countLines(path.join(opDirOf(ctx, kind), "calls.log"));
const setBehavior = (ctx, kind, b) => writeFileSync(path.join(opDirOf(ctx, kind), "behavior.json"), JSON.stringify(b));
const scanSub = (ctx, kind, what) => path.join(ctx.dirs.scan, kind, what);

// kind: prod | ctrl | https
async function startGate(ctx, kind) {
  const env = {
    ...process.env,
    KS1P_SITES: ctx.sitesFile,
    KS1P_OP_CMD: JSON.stringify([process.execPath, FAKE_OP]),
    KS1P_LOG_DIR: scanSub(ctx, kind, "gate-log"),
    KS1P_APPROVAL_TIMEOUT_MS: "3000",
    KS1P_NOTIFY: "off",
    KS1P_TEST_MODE: "1",
    FAKE_OP_DIR: opDirOf(ctx, kind),
  };
  if (kind !== "https") env.KS1P_ALLOW_HTTP_LOOPBACK = "1";
  else delete env.KS1P_ALLOW_HTTP_LOOPBACK;
  if (kind !== "ctrl") delete env.KS1P_TEST_DISABLE_GUARD;
  else env.KS1P_TEST_DISABLE_GUARD = "1";
  // 試験の試験（任意）: LEAK_MUTATE_PROD_GUARD_OFF=1 で本番の入力係の隠す処理も切る。T2・T8・T9・T10 が落ちる事を確かめる用
  if (kind === "prod" && process.env.LEAK_MUTATE_PROD_GUARD_OFF === "1") env.KS1P_TEST_DISABLE_GUARD = "1";
  for (const w of ["transcript", "stderr", "gate-log"]) mkdirSync(scanSub(ctx, kind, w), { recursive: true });
  const c = new McpClient({
    env,
    transcriptPath: path.join(scanSub(ctx, kind, "transcript"), "transcript.jsonl"),
    stderrPath: path.join(scanSub(ctx, kind, "stderr"), "stderr.log"),
    label: kind,
  });
  await c.start();
  ctx.gates[kind] = c;
  // 最初の読み込みの癖に当たる分は、ここで済ませる
  await openPage(c, `${SITE_A}/landing`);
  return c;
}

// ------------------------------------------------------------ 各試験の共通
function newTest(id, title) {
  const checks = [];
  return {
    id,
    title,
    checks,
    ck(name, ok, note = "") {
      checks.push({ name, ok: !!ok, note });
      return !!ok;
    },
    notes: [],
    done() {
      return { id, title, pass: checks.length > 0 && checks.every((c) => c.ok), checks, notes: this.notes };
    },
  };
}

const posts = async (site) => (await site.records()).filter((r) => r.method === "POST");

function credsOf(rec) {
  try {
    if ((rec.contentType || "").includes("json")) {
      const j = JSON.parse(rec.body);
      return { username: j.username, password: j.password };
    }
    const p = new URLSearchParams(rec.body);
    return { username: p.get("username"), password: p.get("password") };
  } catch {
    return { username: null, password: null };
  }
}

const findRef = (snapshotText, name) => {
  const m = new RegExp(`\\[(\\d+)\\] textbox "${name}"`).exec(snapshotText);
  return m ? Number(m[1]) : null;
};

// Kitesurf の最初の読み込みは時間内に終わらない事がある（既知の癖）。その時だけやり直し、回数を report に残す。
const openStats = { retries: 0, failed: 0 };
async function openPage(c, url) {
  let r = await c.call("open", { url });
  for (let i = 0; i < 2 && r.isError && /読み込みが時間内/.test(r.text); i++) {
    openStats.retries++;
    r = await c.call("open", { url });
  }
  if (r.isError) openStats.failed++;
  return r;
}

// ------------------------------------------------------------ T1
async function placeControlFiles(ctx, t) {
  const C = ctx.vals.ctrl.Cctl;
  // 独立に作った形（leak-scan の形の作り方は使わない）
  const content =
    [
      `raw:${C}`,
      `url:${encodeURIComponent(C)}`,
      `json:${JSON.stringify(C)}`,
      `b64:${Buffer.from(C).toString("base64")}`,
      `b64id:${Buffer.from("ctl-user:" + C).toString("base64")}`,
      `hex:${Buffer.from(C).toString("hex")}`,
      `rev:${Array.from(C).reverse().join("")}`,
      `html:${Array.from(C, (c) => "&#" + c.codePointAt(0) + ";").join("")}`,
    ].join("\n") + "\n";
  const name = `ks1p-control-${ctx.runId}.txt`;
  const place = {
    "gate-log": path.join(scanSub(ctx, "prod", "gate-log"), name),
    stderr: path.join(scanSub(ctx, "prod", "stderr"), name),
    "win-tmp": path.join(os.tmpdir(), name),
  };
  for (const [loc, p] of Object.entries(place)) {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    ctx.placed.push({ loc, win: p });
  }
  for (const [loc, p] of Object.entries({ "wsl-tmp": `/tmp/${name}`, wrangler: `${WRANGLER}/${name}` })) {
    const r = await runWsl(["tee", p], { input: content });
    if (r.code !== 0) t.notes.push(`${loc} に対照を置けない`);
    ctx.placed.push({ loc, wsl: p });
  }
}

// 場所ごとの探し先と、そのうち「有るはず」の物（mustExist）。無いと 0 件でも判定不能になる。
//   transcript・gate-log・stderr: startGate が prod・https の記録の置き場（フォルダ）を必ず作る（T3 の https は T3 で起こす）→ 有るはず
//   kitesurf-log: copyKitesurfLog が成功した時に写し先のフォルダとファイルを作る → 有るはず（失敗した時は copyFailed で判定不能）
//   win-tmp: os.tmpdir() → 有るはず
//   wsl-tmp: /tmp → 有るはず
//   wrangler: Kitesurf が何かを書いた時に出来る置き場。まだ何も書かれていなければ無い → 無くてよい（有れば探す）
async function scanLocation(ctx, loc, needlesFile, needles, since) {
  const d = ctx.dirs;
  let roots;
  let mustExist;
  let res;
  switch (loc) {
    case "transcript":
    case "gate-log":
    case "stderr":
      roots = [scanSub(ctx, "prod", loc), scanSub(ctx, "https", loc)];
      mustExist = roots;
      res = localScan(roots, needles, since, loc === "transcript" ? BIG_BYTES : DEFAULT_MAX_BYTES);
      break;
    case "kitesurf-log": {
      // 写せなかった時は、前に写した古い物が残っていても使えない。場所ごと「判定不能」にする（copyFailed）
      const cp = await copyKitesurfLog(path.join(d.scan, "kitesurf", "kitesurf.log"), ctx.kitesurfOffset);
      roots = [path.join(d.scan, "kitesurf")];
      mustExist = roots;
      res = localScan(roots, needles, 0, BIG_BYTES);
      if (!cp.ok) res.copyFailed = cp.error;
      break;
    }
    case "win-tmp":
      roots = [os.tmpdir()];
      mustExist = roots;
      res = localScan(roots, needles, since);
      break;
    case "wsl-tmp":
      roots = ["/tmp"];
      mustExist = roots;
      res = await wslScan(roots, needlesFile, since);
      break;
    case "wrangler":
      roots = [WRANGLER];
      mustExist = [];
      res = await wslScan(roots, needlesFile, since);
      break;
    default:
      throw new Error(`知らない場所: ${loc}`);
  }
  return { ...res, roots, mustExist };
}

const LOCATIONS = ["transcript", "gate-log", "stderr", "kitesurf-log", "win-tmp", "wsl-tmp", "wrangler"];
const LOC_LABEL = {
  transcript: "記録係の記録",
  "gate-log": "入力係の記録",
  stderr: "入力係の stderr",
  "kitesurf-log": "Kitesurf の記録",
  "win-tmp": "Windows の一時フォルダ",
  "wsl-tmp": "WSL の /tmp",
  wrangler: "Kitesurf の .wrangler",
};

async function T1(ctx) {
  const t = newTest("T1", "対照（隠す処理を切ると値が出る・探す力）");
  const v = ctx.vals.ctrl;
  const c = await startGate(ctx, "ctrl");
  const since = ctx.startedAt - 2000;
  try {
    // login-js に login → snapshot・screenshot
    let r = await openPage(c, `${SITE_A}/login-js`);
    t.ck("対照: login-js を開けた", !r.isError);
    r = await c.call("login", { site: "test-a", reason: "対照の試験" });
    const lj = McpClient.parseLogin(r);
    t.ck("対照: login-js の login が submitted", lj?.status === "submitted", lj?.status ?? "読めない");
    r = await c.call("snapshot");
    t.ck("対照: snapshot の返事の先頭に印が付く", r.text.startsWith("[TEST: guard disabled]"));
    const snapText = r.text;
    r = await c.call("screenshot");
    t.ck("対照: screenshot が返った", !r.isError && !!r.image);
    const scanCtl = makeScanner([{ name: "S", value: v.S, id: v.U }]);
    t.ck("対照: snapshot に対照の S が出る", scanCtl(snapText) > 0);

    // big の画面: login で Socr（写真に写る）
    r = await openPage(c, `${SITE_A}/login-js-big`);
    r = await c.call("login", { site: "test-ocr", reason: "対照の試験" });
    t.ck("対照: big の login が submitted", McpClient.parseLogin(r)?.status === "submitted");
    r = await c.call("screenshot");
    if (r.image) writeFileSync(path.join(ctx.dirs.shots, "ctrl-login.png"), r.image);
    t.ck("対照: big の screenshot が返った", !r.isError && !!r.image);
    if (r.image) {
      const o = await ocrCheck(path.join(ctx.dirs.shots, "ctrl-login.png"), v.Socr, { sanity: BIG_HEADING, textFile: path.join(ctx.dirs.shots, "ctrl-login.txt") });
      t.ck("対照: 文字読み取りで Socr が読める（8 字以上続けて一致）", o.anyFound, `最長 ${o.maxRun} 字`);
      t.ck("対照: 文字読み取りが見出しを読めた（読み取り自体は動いている）", o.sanityOk === true);
    }
    // big の画面: AI が Cai を打って撮る
    r = await openPage(c, `${SITE_A}/login-js-big`);
    r = await c.call("snapshot");
    const ref = findRef(r.text, "パスワード");
    t.ck("対照: パスワード欄の ref が見つかった", ref !== null);
    if (ref !== null) {
      r = await c.call("type", { ref, text: v.Cai });
      t.ck("対照: type が ok", r.text.replace(/^\[TEST: guard disabled\]\n/, "") === "ok");
      r = await c.call("screenshot");
      if (r.image) writeFileSync(path.join(ctx.dirs.shots, "ctrl-cai.png"), r.image);
      t.ck("対照: Cai の画面の screenshot が返った", !r.isError && !!r.image);
      if (r.image) {
        const o = await ocrCheck(path.join(ctx.dirs.shots, "ctrl-cai.png"), v.Cai, { sanity: BIG_HEADING, textFile: path.join(ctx.dirs.shots, "ctrl-cai.txt") });
        t.ck("対照: 文字読み取りで Cai が読める（8 字以上続けて一致）", o.anyFound, `最長 ${o.maxRun} 字`);
      }
    }
    // Kitesurf の記録に出す: ?c=Cctl の住所
    r = await openPage(c, `${SITE_A}/landing?c=${encodeURIComponent(v.Cctl)}`);
    t.ck("対照: ?c= の住所を開けた", !r.isError);
  } finally {
    await c.close();
  }

  // 置けない場所に対照を置く
  await placeControlFiles(ctx, t);

  // 場所ごとに対照が見つかるか
  const natural = {
    transcript: { needles: ctx.needlesCtrl, file: ctx.needlesFile.ctrl, how: "本物の道筋（対照の入力係の記録係の記録に出た S）" },
    "kitesurf-log": { needles: ctx.needlesCtl, file: ctx.needlesFile.ctl, how: "本物の道筋（?c= の住所が Kitesurf の記録に出た）" },
  };
  for (const loc of LOCATIONS) {
    let res;
    let how;
    if (loc === "transcript") {
      // 対照の入力係の記録係の記録を探す（本番の探し場所と同じ作りの場所）
      res = localScan([scanSub(ctx, "ctrl", "transcript")], ctx.needlesCtrl.filter((n) => n.name === "S"), 0, BIG_BYTES);
      how = natural.transcript.how;
    } else if (loc === "kitesurf-log") {
      // 出るまで少し待つ
      for (let i = 0; i < 6; i++) {
        res = await scanLocation(ctx, loc, ctx.needlesFile.ctl, ctx.needlesCtl, since);
        if (res.ok && res.total > 0) break;
        await sleep(1000);
      }
      how = natural["kitesurf-log"].how;
    } else {
      res = await scanLocation(ctx, loc, ctx.needlesFile.ctl, ctx.needlesCtl, since);
      how = "置いた対照（Cctl の形を変えた物を書いたファイル）";
    }
    const forms = new Set();
    for (const h of res?.hits ?? []) for (const f of Object.keys(h.forms)) forms.add(f);
    const found = !!res?.ok && res.total > 0;
    // 置いた対照は複数の形で見つかるはず（形ごとの見つける力）
    const multi = loc === "transcript" || loc === "kitesurf-log" ? found : forms.size >= 6;
    ctx.controls[loc] = { ok: found && multi, how, found, forms: [...forms].sort(), hits: res?.total ?? 0, error: res?.ok === false ? res.error : undefined };
    t.ck(`対照: ${LOC_LABEL[loc]}で見つかる（${how}）`, ctx.controls[loc].ok, `形 ${forms.size} 種・${res?.total ?? 0} 件${res?.ok === false ? "・" + res.error : ""}`);
  }
  return t.done();
}

// ------------------------------------------------------------ T2
async function T2(ctx) {
  const t = newTest("T2", "本番で 3 通りの画面に login・値が出ない");
  const c = ctx.gates.prod;
  const v = ctx.vals.prod;
  const scanAll = makeScanner([...ctx.needlesProd, { name: "U", value: v.U }]);
  for (const page of ["login-post", "login-js", "login-enter"]) {
    await ctx.site.reset();
    let r = await openPage(c, `${SITE_A}/${page}`);
    t.ck(`${page}: 開けた`, !r.isError, r.isError ? r.text.slice(0, 80) : "");
    r = await c.call("login", { site: "test-a", reason: `試験 ${page}` });
    const j = McpClient.parseLogin(r);
    t.ck(`${page}: submitted`, j?.status === "submitted", j?.status ?? "読めない");
    const ps = await posts(ctx.site);
    t.ck(`${page}: 受け口に POST が 1 回`, ps.length === 1, `${ps.length} 回`);
    const cr = ps.length ? credsOf(ps[0]) : { username: null, password: null };
    t.ck(`${page}: 受け口の ID が U と完全に一致`, cr.username === v.U);
    t.ck(`${page}: 受け口のパスワードが S と完全に一致`, cr.password === v.S);
    t.ck(`${page}: login の返事に値が無い`, scanAll(r.text) === 0);
    const s = await c.call("snapshot");
    t.ck(`${page}: 続く snapshot が値なしで返る`, !s.isError && scanAll(s.text) === 0, s.isError ? s.text.slice(0, 80) : "");
    const sh = await c.call("screenshot");
    t.ck(`${page}: 続く screenshot が返る`, !sh.isError && !!sh.image, sh.isError ? sh.text.slice(0, 80) : "");
    t.ck(`${page}: screenshot の文字に値が無い`, scanAll(sh.text) === 0);
  }
  return t.done();
}

// ------------------------------------------------------------ T3
async function T3(ctx) {
  const t = newTest("T3", "断る（呼び出し 0 回・受け口に何も届かない）");
  const prod = ctx.gates.prod;
  const https = await startGate(ctx, "https");
  const cases = [
    { n: "localhost の名前", url: `http://localhost:9921/login-post`, exp: "mismatch" },
    { n: "B のポート", url: `${SITE_B}/login-post`, exp: "mismatch" },
    { n: "住所の途中に A を含む B", url: `${SITE_B}/127.0.0.1:9921/login-post?next=${SITE_A}/login-post`, exp: "mismatch" },
    { n: "https 必須で http", gate: "https", url: `${SITE_A}/login-post`, exp: "mismatch" },
    { n: "iframe（別 origin）", url: `${SITE_A}/iframe-cross`, exp: "not_found", frame: { port: 9922, path: "/login-post" } },
    { n: "iframe（同じ origin）", url: `${SITE_A}/iframe-same`, exp: "not_found", frame: { port: 9921, path: "/login-post" } },
    { n: "パスワード欄 2 つ", url: `${SITE_A}/two-passwords`, exp: "not_found" },
    { n: "パスワード欄 無し", url: `${SITE_A}/no-password`, exp: "not_found" },
    { n: "送り先が B", url: `${SITE_A}/action-other`, exp: "mismatch" },
    { n: "GET（明示）", url: `${SITE_A}/login-get`, exp: "error" },
    { n: "GET（既定）", url: `${SITE_A}/login-default-get`, exp: "error" },
    { n: "一覧に無い名前", url: `${SITE_A}/login-post`, site: "nonexist", exp: "not_found" },
    { n: "項目の住所が B（呼び出し 1 回で値を捨てる）", url: `${SITE_A}/login-post`, site: "test-itemb", exp: "mismatch", calls: 1 },
  ];
  try {
    for (const k of cases) {
      const kind = k.gate ?? "prod";
      const c = kind === "https" ? https : prod;
      await ctx.site.reset();
      const before = callsOf(ctx, kind);
      const o = await openPage(c, k.url);
      if (o.isError) {
        t.ck(`${k.n}: 開けた（開けない時は合格に数えない）`, false, o.text.slice(0, 80));
        continue;
      }
      const r = await c.call("login", { site: k.site ?? "test-a", reason: `試験 ${k.n}` });
      const j = McpClient.parseLogin(r);
      t.ck(`${k.n}: ${k.exp} で断る`, j?.status === k.exp, `返った種類 ${j?.status ?? "読めない"}`);
      const used = callsOf(ctx, kind) - before;
      t.ck(`${k.n}: 偽の op の呼び出し ${k.calls ?? 0} 回`, used === (k.calls ?? 0), `${used} 回`);
      const recs = await ctx.site.records();
      t.ck(`${k.n}: 受け口に POST が届かない`, recs.filter((x) => x.method === "POST").length === 0);
      if (k.frame) {
        t.ck(`${k.n}: iframe の中が実際に読み込まれた（試験の前提）`, recs.some((x) => x.method === "GET" && x.port === k.frame.port && x.path === k.frame.path));
      }
    }
  } finally {
    await https.close();
  }
  return t.done();
}

// ------------------------------------------------------------ T4
async function interrupted(ctx, c, page) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await ctx.site.reset();
    const o = await openPage(c, `${SITE_A}/${page}`);
    // 開く間に 700ms が過ぎて移っていたら、試験の前提が崩れている（やり直す）
    if (o.isError || !o.text.includes(`/${page}`)) {
      last = { premise: false, attempt };
      continue;
    }
    const r = await c.call("login", { site: "test-a", reason: `試験 ${page}` });
    const j = McpClient.parseLogin(r);
    // 最初の確かめが移った後の画面に当たった（not_found）なら前提が崩れている
    if (j?.status === "not_found" && attempt < 2) {
      last = { premise: false, attempt, j };
      continue;
    }
    return { j, attempt };
  }
  return { j: last?.j ?? null, attempt: 2 };
}

async function T4(ctx) {
  const t = newTest("T4", "承認待ちの割り込み・断る・打ち切り");
  const c = ctx.gates.prod;
  await ctx.site.reset();
  setBehavior(ctx, "prod", { mode: "ok", delayMs: 1500 });
  try {
    for (const [page, label] of [
      ["change-during-approval", "承認待ちの間にページが移る"],
      ["replace-during-approval", "承認待ちの間に欄が入れ替わる"],
    ]) {
      const { j, attempt } = await interrupted(ctx, c, page);
      t.ck(`${label}: changed`, j?.status === "changed", `返った種類 ${j?.status ?? "読めない"}`);
      if (attempt > 0) t.notes.push(`${label}: 前提が崩れてやり直した ${attempt} 回`);
    }
    setBehavior(ctx, "prod", { mode: "deny", delayMs: 0 });
    await openPage(c, `${SITE_A}/login-post`);
    let r = await c.call("login", { site: "test-a", reason: "試験 断る" });
    t.ck("断る: denied", McpClient.parseLogin(r)?.status === "denied", McpClient.parseLogin(r)?.status ?? "読めない");

    setBehavior(ctx, "prod", { mode: "timeout", delayMs: 0 });
    await openPage(c, `${SITE_A}/login-post`);
    r = await c.call("login", { site: "test-a", reason: "試験 打ち切り" });
    const j = McpClient.parseLogin(r);
    t.ck("打ち切り: timeout", j?.status === "timeout", j?.status ?? "読めない");
    t.ck("打ち切り: 4 分ではなく 3 秒ほどで返った（2.5〜10 秒）", r.ms >= 2500 && r.ms <= 10000, `${r.ms}ms`);
    const ps = await posts(ctx.site);
    t.ck("受け口に何も届かない", ps.length === 0, `${ps.length} 回`);
  } finally {
    setBehavior(ctx, "prod", { mode: "ok", delayMs: 0 });
  }
  return t.done();
}

// ------------------------------------------------------------ T8
async function T8(ctx) {
  const t = newTest("T8", "login の最中の同時呼び出し");
  const c = ctx.gates.prod;
  await ctx.site.reset();
  setBehavior(ctx, "prod", { mode: "ok", delayMs: 1500 });
  try {
    await openPage(c, `${SITE_A}/login-js`);
    const s0 = await c.call("snapshot");
    const ref = findRef(s0.text, "ユーザー名");
    t.ck("前提: ユーザー名欄の ref が取れた", ref !== null);
    const pLogin = c.call("login", { site: "test-a", reason: "試験 同時" });
    await sleep(200);
    const pSnap = c.call("snapshot");
    const pShot = c.call("screenshot");
    const pClick = c.call("click", { ref: ref ?? 1 });
    const [rl, rs, rh, rc] = await Promise.all([pLogin, pSnap, pShot, pClick]);
    const j = McpClient.parseLogin(rl);
    t.ck("login が submitted", j?.status === "submitted", j?.status ?? "読めない");
    for (const [name, r] of [["snapshot", rs], ["screenshot", rh], ["click", rc]]) {
      t.ck(`${name} は login の最中に出された`, r.sentAt < rl.recvAt, `送信 +${r.sentAt - rl.sentAt}ms・login の返事 +${rl.recvAt - rl.sentAt}ms`);
      t.ck(`${name} の返事は login の返事より後`, r.recvAt >= rl.recvAt, `差 ${r.recvAt - rl.recvAt}ms`);
    }
    const scan = makeScanner(ctx.needlesProd);
    t.ck("同時に出した 3 つの返事に値が無い", scan(rs.text) + scan(rh.text) + scan(rc.text) === 0);
    const trRoot = scanSub(ctx, "prod", "transcript");
    const tr = localScan([trRoot], ctx.needlesProd, 0, BIG_BYTES);
    const trWhy = inconclusiveReasons(tr, [trRoot]);
    t.ck("記録係の記録に 0 件", tr.ok && tr.total === 0, `${tr.total} 件`);
    t.ck("記録係の記録を全部探せた（読めない・上限超え・無い探し先が無い）", trWhy.length === 0, trWhy.join("・") || "全部探せた");
    ctx.t8 = { loginMs: rl.ms, others: [rs, rh, rc].map((r) => ({ name: r.name, sentAfterMs: r.sentAt - rl.sentAt, recvAfterLoginMs: r.recvAt - rl.recvAt })) };
  } finally {
    setBehavior(ctx, "prod", { mode: "ok", delayMs: 0 });
  }
  return t.done();
}

// ------------------------------------------------------------ T9
async function T9(ctx) {
  const t = newTest("T9", "画面写真の文字読み取り（本番）");
  const c = ctx.gates.prod;
  const v = ctx.vals.prod;
  await ctx.site.reset();
  let r = await openPage(c, `${SITE_A}/login-js-big`);
  r = await c.call("login", { site: "test-ocr", reason: "試験 写真" });
  t.ck("big: login が submitted", McpClient.parseLogin(r)?.status === "submitted", McpClient.parseLogin(r)?.status ?? "読めない");
  r = await c.call("screenshot");
  t.ck("login の後の screenshot が返った（欄が空・値が画面に無い）", !r.isError && !!r.image, r.isError ? r.text.slice(0, 80) : "");
  if (r.image) {
    const f = path.join(ctx.dirs.shots, "prod-login.png");
    writeFileSync(f, r.image);
    const o = await ocrCheck(f, v.Socr, { sanity: BIG_HEADING, textFile: path.join(ctx.dirs.shots, "prod-login.txt") });
    t.ck("Socr が 8 字以上続けて出ない", !o.anyFound, `最長 ${o.maxRun} 字`);
    t.ck("文字読み取りは見出しを読めた（空の写真を 0 件と数えない）", o.sanityOk === true);
  }
  // AI が Cai をパスワード欄に打って撮る
  r = await openPage(c, `${SITE_A}/login-js-big`);
  r = await c.call("snapshot");
  const ref = findRef(r.text, "パスワード");
  t.ck("パスワード欄の ref が見つかった", ref !== null);
  if (ref !== null) {
    r = await c.call("type", { ref, text: v.Cai });
    t.ck("type が ok", r.text === "ok", r.text.slice(0, 60));
    r = await c.call("screenshot");
    t.ck("Cai を打った後の screenshot が返った", !r.isError && !!r.image, r.isError ? r.text.slice(0, 80) : "");
    if (r.image) {
      const f = path.join(ctx.dirs.shots, "prod-cai.png");
      writeFileSync(f, r.image);
      const o = await ocrCheck(f, v.Cai, { sanity: BIG_HEADING, textFile: path.join(ctx.dirs.shots, "prod-cai.txt") });
      t.ck("Cai が 8 字以上続けて出ない", !o.anyFound, `最長 ${o.maxRun} 字`);
      t.ck("文字読み取りは見出しを読めた", o.sanityOk === true);
    }
  }
  return t.done();
}

// ------------------------------------------------------------ T10
async function T10(ctx) {
  const t = newTest("T10", "本番の全部の場所で 0 件");
  const since = ctx.startedAt - 2000;
  ctx.t10 = {};
  for (const loc of LOCATIONS) {
    const res = await scanLocation(ctx, loc, ctx.needlesFile.prod, ctx.needlesProd, since);
    const ctl = ctx.controls[loc];
    const scanOk = res.ok;
    const zero = scanOk && res.total === 0;
    const hasCtl = !!ctl?.ok;
    // 0 件でも、探せなかった物（読めない・上限超え・有るはずの探し先が無い）があれば判定不能
    const why = inconclusiveReasons(res, res.mustExist, res.roots);
    const conclusive = scanOk && why.length === 0;
    ctx.t10[loc] = {
      hits: res.ok ? res.total : null,
      scanned: res.scanned,
      skippedOld: res.skippedOld,
      skippedLarge: res.skippedLarge,
      unreadable: res.unreadable,
      unreadableSamples: res.unreadableSamples,
      unreadableOldDirs: res.unreadableOldDirs,
      unreadableOldDirSamples: res.unreadableOldDirSamples,
      missingRoots: res.missingRoots,
      skippedOther: res.skippedOther,
      roots: res.roots,
      mustExist: res.mustExist,
      inconclusiveReasons: why,
      files: res.hits,
      control: hasCtl ? ctl.how : "対照なし",
      verdict: !scanOk ? "探せない" : !zero ? "漏れあり" : !conclusive ? "判定不能" : hasCtl ? "0 件（対照あり）" : "対照なし",
      error: res.ok ? undefined : res.error,
    };
    const counts = scanOk
      ? `探した ${res.scanned}・古くて飛ばした ${res.skippedOld}・大きくて探せなかった ${res.skippedLarge}・読めなかった ${res.unreadable}・読めない古いフォルダ ${res.unreadableOldDirs}・無かった探し先 ${res.missingRoots.length}`
      : res.error;
    t.ck(`${LOC_LABEL[loc]}: 0 件`, zero, scanOk ? `${res.total} 件・${counts}` : res.error);
    t.ck(`${LOC_LABEL[loc]}: 全部探せた（読めなかった物・上限超え・有るはずの探し先が無い、が無い。有れば 0 件でも判定不能）`, conclusive, conclusive ? counts : `判定不能: ${why.join("・")}（${counts}）`);
    t.ck(`${LOC_LABEL[loc]}: 対照が通った場所である（通らない場所の 0 件は合格にしない）`, hasCtl, hasCtl ? ctl.how : "対照なし");
  }
  return t.done();
}

// ------------------------------------------------------------ 後始末
async function cleanupPlaced(ctx) {
  for (const p of ctx.placed) {
    try {
      if (p.win) rmSync(p.win, { force: true });
      if (p.wsl) await runWsl(["rm", "-f", p.wsl]);
    } catch {}
  }
  ctx.placed = [];
}

// ------------------------------------------------------------ 1 回
async function runOnce(runIdx, site, stamp) {
  const ctx = makeCtx(runIdx, site, stamp);
  ctx.kitesurfOffset = await kitesurfLogSize();
  const results = [];
  const guarded = async (fn, id, title) => {
    const t0 = Date.now();
    try {
      const r = await fn(ctx);
      r.ms = Date.now() - t0;
      results.push(r);
    } catch (e) {
      results.push({ id, title, pass: false, ms: Date.now() - t0, checks: [{ name: "試験が例外で止まった", ok: false, note: `${e?.name ?? "Error"}: ${String(e?.message ?? "").slice(0, 120)}` }], notes: [] });
    }
    const r = results[results.length - 1];
    console.log(`  ${r.pass ? "PASS" : "FAIL"} ${r.id} ${r.title} (${(r.ms / 1000).toFixed(1)}s)`);
    for (const c of r.checks) if (!c.ok) console.log(`       x ${c.name}${c.note ? "  [" + c.note + "]" : ""}`);
  };
  try {
    await ctx.site.reset();
    await guarded(T1, "T1", "対照");
    await startGate(ctx, "prod");
    await guarded(T2, "T2", "login 3 通り");
    await guarded(T3, "T3", "断る");
    await guarded(T4, "T4", "承認待ちの割り込み");
    await guarded(T8, "T8", "同時の呼び出し");
    await guarded(T9, "T9", "画面写真の文字読み取り");
    await ctx.gates.prod.close();
    await guarded(T10, "T10", "全部の場所で 0 件");
  } finally {
    for (const g of Object.values(ctx.gates)) await g.close().catch(() => {});
    await cleanupPlaced(ctx);
  }

  const report = {
    run: ctx.runId,
    startedAt: new Date(ctx.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    node: process.version,
    tests: results,
    controls: ctx.controls,
    t10: ctx.t10,
    t8: ctx.t8,
    openStats: { ...openStats },
    passAll: results.length === 7 && results.every((r) => r.pass),
  };
  const reportFile = path.join(ctx.dirs.run, "report.json");
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  // report も探す対象
  const rs = localScan([reportFile], ctx.needlesProd, 0, BIG_BYTES);
  report.reportScan = rs.ok ? { hits: rs.total } : { error: rs.error };
  report.passAll = report.passAll && rs.ok && rs.total === 0 && inconclusiveReasons(rs, [reportFile]).length === 0;
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  const rs2 = localScan([reportFile], ctx.needlesProd, 0, BIG_BYTES);
  if (!rs2.ok || rs2.total !== 0 || inconclusiveReasons(rs2, [reportFile]).length > 0) {
    report.passAll = false;
    report.reportScan = { hits: rs2.total, error: rs2.error };
    writeFileSync(reportFile, JSON.stringify(report, null, 2));
  }
  console.log(`  report: ${reportFile}  (report の中の値: ${rs2.ok ? rs2.total : "探せない"} 件)`);
  return report;
}

// ------------------------------------------------------------ 表
function printTable(reports) {
  const ids = ["T1", "T2", "T3", "T4", "T8", "T9", "T10"];
  console.log("\n==== 結果 ====");
  const head = ["試験", ...reports.map((r) => r.run.slice(-12)), "検査(合格/全部)"];
  console.log(head.join("\t"));
  for (const id of ids) {
    const row = [id];
    let ok = 0;
    let all = 0;
    for (const r of reports) {
      const t = r.tests.find((x) => x.id === id);
      row.push(t ? (t.pass ? "PASS" : "FAIL") : "-");
      if (t) {
        ok += t.checks.filter((c) => c.ok).length;
        all += t.checks.length;
      }
    }
    row.push(`${ok}/${all}`);
    console.log(row.join("\t"));
  }
  const t11 = reports.length >= 3 ? (reports.every((r) => r.passAll) ? "PASS" : "FAIL") : "(--runs 3 以上で判定)";
  console.log(`T11\t${t11}\t（${reports.filter((r) => r.passAll).length}/${reports.length} 回が全部合格）`);
  console.log("\n場所ごとの対照と本番の 0 件（最後の回）:");
  const last = reports[reports.length - 1];
  for (const loc of LOCATIONS) {
    const c = last.controls[loc];
    const t = last.t10?.[loc];
    console.log(`  ${LOC_LABEL[loc].padEnd(22)} 対照: ${c?.ok ? "見つかった" : "対照なし"}（${c?.how ?? "-"}）  本番: ${t?.hits ?? "?"} 件  [${t?.verdict ?? "-"}]`);
    const miss = t?.missingRoots ? (t.missingRoots.length ? t.missingRoots.join(",") : "0") : "?";
    console.log(
      `    探した ${t?.scanned ?? "?"}・古くて飛ばした ${t?.skippedOld ?? "?"}・大きくて探せなかった ${t?.skippedLarge ?? "?"}・読めなかった ${t?.unreadable ?? "?"}・読めない古いフォルダ ${t?.unreadableOldDirs ?? "?"}・無かった探し先 ${miss}` +
        (t?.inconclusiveReasons?.length ? `  判定不能: ${t.inconclusiveReasons.join("・")}` : ""),
    );
  }
}

// ------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  let runs = 1;
  const i = args.indexOf("--runs");
  if (i >= 0) runs = Math.max(1, Number(args[i + 1]) || 1);

  if (!(await kitesurfHealthy())) {
    console.error("Kitesurf の /health が返らない（scripts/kitesurf-dev.sh で起動してから回す）");
    process.exit(2);
  }
  mkdirSync(RUN_BASE, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const site = await startTestSite();
  const reports = [];
  const onSig = async () => {
    await site.stop();
    process.exit(130);
  };
  process.on("SIGINT", onSig);
  try {
    for (let n = 1; n <= runs; n++) {
      console.log(`\n=== 回 ${n}/${runs}（新しい値） ===`);
      reports.push(await runOnce(n, site, stamp));
    }
  } finally {
    await site.stop();
  }
  printTable(reports);
  const all = reports.every((r) => r.passAll);
  console.log(`\n総合: ${all ? "全部合格" : "落ちた物がある"}`);
  process.exit(all ? 0 : 1);
}

main().catch((e) => {
  console.error("試験が止まった:", e?.name ?? "Error", String(e?.message ?? "").slice(0, 200));
  process.exit(2);
});
