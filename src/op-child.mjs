// 使い捨てのプロセス。op（本物の op.exe か偽の op）を呼び、{"username","password","urls"} の 1 行だけを stdout に書いて終わる。
// 終了番号: 0=成功、3=断られた、4=項目が無い、5=その他（時間切れ・命令が見つからない・引数がおかしい）。op の stderr は親に渡さない。
// 引数: <item> [--vault v] [--account a] [--timeout-ms n]。n は親が待つ長さ。こちらはそれより少し長く待って、孫の op を止めて終わる。
import { spawn } from "node:child_process";
import { resolveCommand } from "./resolve-cmd.mjs";
import { killProcessTree } from "./proc.mjs";

const OP_CHILD_GRACE_MS = 3000;
const DEFAULT_TIMEOUT_MS = 300000;

function parseArgs(argv) {
  const out = { item: "", vault: "", account: "", timeoutMs: DEFAULT_TIMEOUT_MS };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--vault") out.vault = argv[++i] ?? "";
    else if (argv[i] === "--account") out.account = argv[++i] ?? "";
    else if (argv[i] === "--timeout-ms") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.timeoutMs = Math.floor(n);
    } else rest.push(argv[i]);
  }
  out.item = rest[0] ?? "";
  return out;
}

function classify(stderr) {
  const s = stderr.toLowerCase();
  if (/dismissed|denied|cancel|authorization/.test(s)) return 3;
  if (/isn't an item|not found|more than one/.test(s)) return 4;
  return 5;
}

function pick(fields, purpose, id) {
  const list = Array.isArray(fields) ? fields : [];
  const f = list.find((x) => x && x.purpose === purpose) ?? list.find((x) => x && x.id === id);
  return f && typeof f.value === "string" ? f.value : null;
}

async function main() {
  const { item, vault, account, timeoutMs } = parseArgs(process.argv.slice(2));
  if (!item) process.exit(5);
  // op のオプションと取り違えない
  if ([item, vault, account].some((s) => s.trim().startsWith("-"))) process.exit(5);
  let cmd;
  try {
    cmd = JSON.parse(process.env.KS1P_OP_CMD || '["op.exe"]');
    if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((s) => typeof s === "string" && s)) throw new Error("x");
  } catch {
    process.exit(5);
  }
  // 先頭が名前だけなら、PATH の絶対の住所のフォルダだけから探す。見つからなければ 5。
  const exe = resolveCommand(cmd[0]);
  if (!exe) process.exit(5);
  const args = [...cmd.slice(1), "item", "get", item, "--format", "json", "--reveal"];
  if (vault) args.push("--vault", vault);
  if (account) args.push("--account", account);

  const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
  // 自分にも時間切れを持つ（親の待つ長さより少し長く）。孫の op を止めて 5 で終わる。
  const timer = setTimeout(() => {
    killProcessTree(child.pid, { group: false });
    process.exit(5);
  }, timeoutMs + OP_CHILD_GRACE_MS);
  const out = [];
  const err = [];
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => err.push(d));
  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", (c) => resolve(c));
  });
  clearTimeout(timer);
  if (code !== 0) {
    process.exit(code === -1 || code === null ? 5 : classify(Buffer.concat(err).toString("utf8")));
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(out).toString("utf8"));
  } catch {
    process.exit(5);
  }
  const password = pick(data.fields, "PASSWORD", "password");
  if (password === null) process.exit(4);
  const username = pick(data.fields, "USERNAME", "username") ?? "";
  const urls = (Array.isArray(data.urls) ? data.urls : []).map((u) => u && u.href).filter((h) => typeof h === "string");
  process.stdout.write(JSON.stringify({ username, password, urls }) + "\n", () => process.exit(0));
}

main().catch(() => process.exit(5));
