// 環境変数とサイト一覧の読み込み。
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

function intEnv(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} は正の数にする`);
  return Math.floor(n);
}

function parseOpCmd(raw) {
  if (raw === undefined || raw === "") return ["op.exe"];
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("KS1P_OP_CMD は JSON の配列にする");
  }
  if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === "string" && s)) {
    throw new Error("KS1P_OP_CMD は文字列の配列にする");
  }
  return v;
}

// このリポの試験用の偽の op（test/fake-op.mjs）の絶対の住所。
const FAKE_OP = path.resolve(HERE, "..", "test", "fake-op.mjs");

// 命令の要素が、このリポの test/fake-op.mjs そのものか（住所を解いて、大文字小文字を区別せず比べる）。
export function isRepoFakeOp(s) {
  if (typeof s !== "string" || s === "") return false;
  return path.resolve(s).toLowerCase() === FAKE_OP.toLowerCase();
}

// NODE_DEBUG が空でなければ理由の文（stderr に出す 1 行）、空なら null。
// Puppeteer は util.debuglog で CDP の送信内容（Input.insertText のパスワードを含む）を stderr に出せるため。
export function nodeDebugProblem(env = process.env) {
  const v = env.NODE_DEBUG;
  if (v === undefined || v === "") return null;
  return "環境変数 NODE_DEBUG が設定されている。依存が CDP の送信内容（入れる値を含む）を stderr に出す恐れがあるため起動しない。NODE_DEBUG を外して起動し直す";
}

// KS1P_KITESURF_WS: ws: で、ホストが 127.0.0.1・::1・localhost だけ。
export function parseKitesurfWs(raw) {
  const bad = () => new Error("KS1P_KITESURF_WS は ws: で、ホストが 127.0.0.1・::1・localhost のものだけ使える");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw bad();
  }
  if (u.protocol !== "ws:" || u.username || u.password) throw bad();
  if (!["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)) throw bad();
  return raw;
}

const dashStart = (v) => typeof v === "string" && v.trim().startsWith("-");

export function parseSites(json) {
  if (!Array.isArray(json)) throw new Error("サイト一覧は配列にする");
  return json.map((s, i) => {
    if (!s || typeof s !== "object") throw new Error(`サイト ${i} が正しくない`);
    if (typeof s.name !== "string" || !s.name) throw new Error(`サイト ${i} に name が無い`);
    let origin;
    try {
      const u = new URL(String(s.origin));
      if (u.username || u.password || (u.protocol !== "https:" && u.protocol !== "http:")) throw new Error("x");
      origin = u.origin;
    } catch {
      throw new Error(`サイト ${s.name} の origin が正しくない`);
    }
    const op = s.op || {};
    if (typeof op.item !== "string" || !op.item) throw new Error(`サイト ${s.name} の op.item が無い`);
    // op のオプションと取り違えるので、"-" で始まる名前は読み込みの誤りにする
    for (const k of ["item", "vault", "account"]) {
      if (dashStart(op[k])) throw new Error(`サイト ${s.name} の op.${k} が "-" で始まっている（op のオプションと取り違えるため使えない）`);
    }
    return {
      name: s.name,
      origin,
      op: {
        item: op.item,
        vault: typeof op.vault === "string" && op.vault ? op.vault : "",
        account: typeof op.account === "string" && op.account ? op.account : "",
      },
      allowGetForm: s.allowGetForm === true,
    };
  });
}

export function loadConfig(env = process.env) {
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const sitesPath = env.KS1P_SITES || path.join(appData, "kitesurf-1p", "sites.json");
  let sites = [];
  try {
    sites = parseSites(JSON.parse(readFileSync(sitesPath, "utf8")));
  } catch (e) {
    if (e && e.code !== "ENOENT") throw new Error(`サイト一覧を読めない: ${e instanceof SyntaxError ? "JSON の形が正しくない" : e.message}`);
  }
  const testMode = env.KS1P_TEST_MODE === "1";
  const opCmd = parseOpCmd(env.KS1P_OP_CMD);
  const disableRequested = env.KS1P_TEST_DISABLE_GUARD === "1";
  const fakeOp = opCmd.some((s) => isRepoFakeOp(s));
  const httpLoopbackRequested = env.KS1P_ALLOW_HTTP_LOOPBACK === "1";
  return {
    kitesurfWs: parseKitesurfWs(env.KS1P_KITESURF_WS || "ws://127.0.0.1:8787/devtools/browser"),
    sitesPath,
    sites,
    opCmd,
    logDir: env.KS1P_LOG_DIR || path.join(localAppData, "kitesurf-1p", "logs"),
    approvalTimeoutMs: intEnv(env, "KS1P_APPROVAL_TIMEOUT_MS", 240000),
    // 照合用の値の期限は無くなった。設定されていたら、起動時に「使われなくなった」と 1 行出す。
    secretTtlIgnored: env.KS1P_SECRET_TTL_MS !== undefined,
    notify: (env.KS1P_NOTIFY || "on") !== "off",
    // KS1P_TEST_MODE=1 の時だけ効く（試験用）
    allowHttpLoopback: testMode && httpLoopbackRequested,
    allowHttpLoopbackRequestedWithoutTestMode: !testMode && httpLoopbackRequested,
    testMode,
    // KS1P_TEST_MODE=1 と KS1P_TEST_DISABLE_GUARD=1 に加え、命令の要素のどれかがこのリポの test/fake-op.mjs そのものの時だけ効く
    guardDisabled: testMode && disableRequested && fakeOp,
    guardDisableRequestedWithoutTestMode: !testMode && disableRequested,
    guardDisableRequestedWithoutFakeOp: testMode && disableRequested && !fakeOp,
  };
}
