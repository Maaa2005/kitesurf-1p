// 本物の 1Password で本人が 1 回だけ回す確かめ（設計書 5 節「手で 1 回だけ確かめる事」）。
//   npm.cmd run check:real（PowerShell では npm.ps1 が止まる事があるため npm.cmd）
// 前提:
//   - Kitesurf は動いていなければ台本が起動し（scripts/kitesurf-dev.sh）、自分で起動した時だけ終わりに止める（kitesurf-stop.sh）
//   - 1Password に試験用の項目 "kitesurf-1p-test" がある:
//       ユーザー名 = ks1p-user、パスワード = EXPECTED_PASSWORD（下の定数と同じ。試験用の作り物の値）、
//       ウェブサイト = http://127.0.0.1:9921
//   - 1Password アプリで CLI 連携がオン（winget で入れた op.exe を使う）
// 手順: login-post に login を 3 回。1・2 回目のあとに 1Password の許可の画面が出たかを聞く。3 回目はキャンセルを押して denied を見る。
// 結果は test/.run/real-<日時>/result.json と画面に出す（値は出さない。一致/不一致だけ）。
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { McpClient, startTestSite, SITE_A, REPO_ROOT } from "../test/lib/mcp-client.mjs";
import { wslArgs, winToWsl } from "../test/lib/wsl.mjs";
import { scanTree } from "../test/lib/leak-scan.mjs";
import { kitesurfHealthUrl, kitesurfPortForScript } from "../test/lib/kitesurf.mjs";

const EXPECTED_USER = "ks1p-user";
const EXPECTED_PASSWORD = "ks1p-テスト-Vq8#mZ2p!試験";
const ITEM = "kitesurf-1p-test";

function findOpExe() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const pkgs = path.join(local, "Microsoft", "WinGet", "Packages");
  try {
    for (const d of readdirSync(pkgs)) {
      if (!/^AgileBits\.1Password\.CLI/i.test(d)) continue;
      const p = path.join(pkgs, d, "op.exe");
      if (existsSync(p)) return p;
    }
  } catch {}
  const link = path.join(local, "Microsoft", "WinGet", "Links", "op.exe");
  if (existsSync(link)) return link;
  return null;
}

const HEALTH_URL = kitesurfHealthUrl();
// WSL（KS1P_WSL_DISTRO・KS1P_WSL_USER）の中で台本を回す。台本の住所は wslpath で求める。
// KITESURF_DIR・KS_LOG・KITESURF_PORT は Windows 側で設定してあれば WSL の台本へ渡す。
// KITESURF_PORT が無く KS1P_KITESURF_WS だけある時は、その port を KITESURF_PORT として渡す。
const wslScript = (name) => {
  const envs = ["KITESURF_DIR", "KS_LOG"].filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`);
  const port = kitesurfPortForScript();
  if (port) envs.push(`KITESURF_PORT=${port}`);
  return ["wsl.exe", ...wslArgs("env", ...envs, "bash", winToWsl(path.join(REPO_ROOT, "scripts", name)))];
};
const START_CMD = wslScript("kitesurf-dev.sh");
const STOP_CMD = wslScript("kitesurf-stop.sh");

async function kitesurfHealthy(url = HEALTH_URL) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return (await r.text()).includes("kitesurf: OK");
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 命令（[実行ファイル, ...引数]）を shell なしで走らせ、終わるまで待つ（上限 timeoutMs）。
function runCmd(cmd, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const c = spawn(cmd[0], cmd.slice(1), { stdio: "ignore", windowsHide: true });
      const t = setTimeout(() => {
        try { c.kill(); } catch {}
        finish(false);
      }, timeoutMs);
      c.on("error", () => { clearTimeout(t); finish(false); });
      c.on("exit", (code) => { clearTimeout(t); finish(code === 0); });
    } catch {
      finish(false);
    }
  });
}

// Kitesurf が動いていなければ起動し、/health が返るまで待つ。
// 戻り値 { ok, started, stop }。started が true の時だけ stop() が止める命令を回す（何度呼んでも 1 回だけ）。
export async function ensureKitesurf({
  healthUrl = HEALTH_URL,
  startCmd = START_CMD,
  stopCmd = STOP_CMD,
  intervalMs = 10_000,
  maxWaitMs = 15 * 60_000,
  stopTimeoutMs = 120_000,
  log = console.log,
} = {}) {
  if (await kitesurfHealthy(healthUrl)) return { ok: true, started: false, stop: async () => {} };
  log("Kitesurf を起動中（数分かかる事がある）");
  let child = null;
  try {
    child = spawn(startCmd[0], startCmd.slice(1), { stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
  } catch {
    child = null;
  }
  let stopped = null;
  const stop = () => {
    if (!stopped) {
      stopped = (async () => {
        await runCmd(stopCmd, stopTimeoutMs);
        try { if (child && child.exitCode === null) child.kill(); } catch {}
      })();
    }
    return stopped;
  };
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    if (await kitesurfHealthy(healthUrl)) return { ok: true, started: true, stop };
  }
  return { ok: false, started: true, stop };
}

const credsOf = (rec) => {
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
};

async function main() {
  const opExe = findOpExe();
  if (!opExe) {
    console.error("winget の op.exe が見つからない（%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\AgileBits.1Password.CLI_*\\op.exe）");
    process.exit(2);
  }
  let ks = { stop: async () => {} };
  let interrupted = false;
  const onSigint = async () => {
    if (interrupted) return;
    interrupted = true;
    console.error("\n中断（Ctrl+C）");
    await ks.stop();
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  ks = await ensureKitesurf();
  if (!ks.ok) {
    console.error("Kitesurf の /health が返らない（15 分待ったが起動しなかった。scripts/kitesurf-dev.sh を確かめる）");
    await ks.stop();
    process.exit(2);
  }
  let code = 2;
  try {
    code = await runCheck(opExe, onSigint);
  } finally {
    await ks.stop();
  }
  process.exit(code);
}

async function runCheck(opExe, onSigint) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = path.join(REPO_ROOT, "test", ".run", `real-${stamp}`);
  const scanDir = path.join(dir, "scan");
  mkdirSync(path.join(scanDir, "transcript"), { recursive: true });
  mkdirSync(path.join(scanDir, "stderr"), { recursive: true });
  mkdirSync(path.join(scanDir, "gate-log"), { recursive: true });
  const sitesFile = path.join(dir, "sites.json");
  writeFileSync(sitesFile, JSON.stringify([{ name: "test-a", origin: "http://127.0.0.1:9921", op: { item: ITEM } }]));

  console.log("本物の 1Password での確かめ（1 回だけ）");
  console.log(`  op.exe: ${opExe}`);
  console.log(`  項目: ${ITEM}（ユーザー名 ${EXPECTED_USER}・パスワードは定数 EXPECTED_PASSWORD・ウェブサイト ${SITE_A}）`);
  console.log("  1Password の許可（パスワードか指紋）が出ます。login を 3 回。1・2 回目は 1Password で許可、3 回目はキャンセルを押す。\n");

  const site = await startTestSite();
  const env = {
    ...process.env,
    KS1P_SITES: sitesFile,
    KS1P_OP_CMD: JSON.stringify([opExe]),
    KS1P_LOG_DIR: path.join(scanDir, "gate-log"),
    KS1P_APPROVAL_TIMEOUT_MS: "120000",
    KS1P_NOTIFY: "on",
    KS1P_ALLOW_HTTP_LOOPBACK: "1",
  };
  // KS1P_ALLOW_HTTP_LOOPBACK は KS1P_TEST_MODE=1 の時だけ効く。隠す処理は切らない（op.exe の時は KS1P_TEST_DISABLE_GUARD も効かない）。
  env.KS1P_TEST_MODE = "1";
  delete env.KS1P_TEST_DISABLE_GUARD;
  const client = new McpClient({
    env,
    transcriptPath: path.join(scanDir, "transcript", "transcript.jsonl"),
    stderrPath: path.join(scanDir, "stderr", "stderr.log"),
    label: "real",
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", onSigint);
  const result = { startedAt: new Date().toISOString(), opExe: path.basename(opExe), steps: [] };
  try {
    await client.start();
    let o = await client.call("open", { url: `${SITE_A}/landing` }); // 最初の読み込みの癖を先に済ませる
    for (let i = 0; i < 2 && o.isError; i++) o = await client.call("open", { url: `${SITE_A}/landing` });

    for (let n = 1; n <= 3; n++) {
      await site.reset();
      o = await client.call("open", { url: `${SITE_A}/login-post` });
      for (let i = 0; i < 2 && o.isError && /読み込みが時間内/.test(o.text); i++) o = await client.call("open", { url: `${SITE_A}/login-post` });
      const step = { n, opened: !o.isError };
      if (n === 3) console.log("\n[3 回目] 1Password の許可の画面が出たら、許可しないで「キャンセル」を押してください（許可するとこの確かめは不合格になります）。");
      else console.log(`\n[${n} 回目] 1Password の許可の画面が出たら許可してください。`);
      const r = await client.call("login", { site: "test-a", reason: `本物の確かめ ${n} 回目` }, { timeoutMs: 180000 });
      const j = McpClient.parseLogin(r);
      step.status = j?.status ?? "読めない";
      step.ms = r.ms;
      if (n <= 2) {
        step.submitted = j?.status === "submitted";
        const ps = (await site.records()).filter((x) => x.method === "POST");
        step.posts = ps.length;
        const cr = ps.length ? credsOf(ps[0]) : { username: null, password: null };
        step.idMatch = cr.username === EXPECTED_USER;
        step.passwordMatch = cr.password === EXPECTED_PASSWORD;
        const a = (await rl.question("1Password の許可の画面が出ましたか (y/n) ")).trim().toLowerCase();
        step.promptShown = a === "y" || a === "yes";
      } else {
        step.denied = j?.status === "denied";
        const ps = (await site.records()).filter((x) => x.method === "POST");
        step.posts = ps.length;
      }
      result.steps.push(step);
      console.log(`  → status=${step.status}` + (n <= 2 ? `  ID ${step.idMatch ? "一致" : "不一致"}  パスワード ${step.passwordMatch ? "一致" : "不一致"}  POST ${step.posts} 回` : `  POST ${step.posts} 回`));
    }
  } finally {
    rl.close();
    await client.close();
    await site.stop();
  }

  // 記録に EXPECTED_PASSWORD が無い事
  const needles = [{ name: "EXPECTED_PASSWORD", value: EXPECTED_PASSWORD, id: EXPECTED_USER }];
  const tr = scanTree({ roots: [path.join(scanDir, "transcript")], needles, maxBytes: 200 * 1024 * 1024 });
  const gl = scanTree({ roots: [path.join(scanDir, "gate-log"), path.join(scanDir, "stderr")], needles });
  result.transcriptHits = tr.total;
  result.gateLogAndStderrHits = gl.total;
  const s = result.steps;
  result.pass =
    s.length === 3 &&
    s[0].submitted && s[0].idMatch && s[0].passwordMatch && s[0].promptShown &&
    s[1].submitted && s[1].idMatch && s[1].passwordMatch && s[1].promptShown &&
    s[2].denied && s[2].posts === 0 &&
    tr.total === 0 && gl.total === 0;
  result.finishedAt = new Date().toISOString();
  writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));

  console.log("\n==== 結果 ====");
  for (const x of s) {
    if (x.n <= 2) console.log(`  ${x.n} 回目: ${x.status}  ID ${x.idMatch ? "一致" : "不一致"}  パスワード ${x.passwordMatch ? "一致" : "不一致"}  1Password の許可の画面 ${x.promptShown ? "出た" : "出ていない"}`);
    else console.log(`  ${x.n} 回目: ${x.status}（denied が期待）  受け口に届いた POST ${x.posts} 回`);
  }
  console.log(`  記録係の記録の EXPECTED_PASSWORD: ${tr.total} 件`);
  console.log(`  入力係の記録・stderr の EXPECTED_PASSWORD: ${gl.total} 件`);
  console.log(`  総合: ${result.pass ? "合格" : "落ちた"}`);
  console.log(`  ${path.join(dir, "result.json")}`);
  return result.pass ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("確かめが止まった:", e?.name ?? "Error", String(e?.message ?? "").slice(0, 200));
    process.exit(2);
  });
}
