// 偽の op。`node test/fake-op.mjs item get <item> --format json --reveal [--vault v] [--account a]`
// 環境変数 FAKE_OP_DIR の items.json・behavior.json を読む。呼ばれるたびに calls.log に 1 行足す（値は書かない）。
import { readFileSync, appendFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_OP_DIR;
const args = process.argv.slice(2);
const fail = (msg, code = 1) => {
  process.stderr.write(msg + "\n");
  process.exit(code);
};

if (!dir) fail("[ERROR] FAKE_OP_DIR is not set");
if (args[0] !== "item" || args[1] !== "get" || !args[2]) fail("[ERROR] unsupported command");
const item = args[2];

// opEnvNames: 受け取った環境のうち名前が OP_ で始まる変数の名前だけ（値は書かない）。cwd: 呼ばれた作業フォルダ。
const opEnvNames = Object.keys(process.env).filter((k) => /^op_/i.test(k));
appendFileSync(
  path.join(dir, "calls.log"),
  JSON.stringify({ t: Date.now(), item, pid: process.pid, ppid: process.ppid, cwd: process.cwd(), opEnvNames }) + "\n",
);

const readJson = (name, def) => {
  try {
    return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
  } catch {
    return def;
  }
};
const items = readJson("items.json", {});
const behavior = { mode: "ok", delayMs: 0, ...readJson("behavior.json", {}) };

if (behavior.mode === "timeout") {
  setInterval(() => {}, 1 << 30); // 終わらない
} else if (behavior.mode === "deny") {
  fail("[ERROR] authorization prompt dismissed, please try again");
} else if (behavior.mode === "error") {
  fail("[ERROR] something went wrong");
} else if (!Object.prototype.hasOwnProperty.call(items, item)) {
  fail(`[ERROR] "${item}" isn't an item.`);
} else {
  setTimeout(() => {
    process.stdout.write(JSON.stringify(items[item]) + "\n", () => process.exit(0));
  }, Number(behavior.delayMs) || 0);
}
