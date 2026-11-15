// 使い捨ての子プロセス op-child.mjs を起動して値を受け取る。値はメモリでだけ受け、記録に書かない。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killProcessTree, safeCwd } from "./proc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OP_CHILD = path.join(HERE, "op-child.mjs");

// 動いている op-child。入力係が終わる時に止める。
const running = new Set();

function killTree(child) {
  if (!child || child.pid === undefined) return;
  killProcessTree(child.pid, { group: process.platform !== "win32" });
}

export function runningChildCount() {
  return running.size;
}

// 動いている op-child を全部止める（入力係の終了の時に呼ぶ）。
export function killAllChildren() {
  for (const c of [...running]) killTree(c);
}

// op-child に渡す環境。名前が OP_ で始まる変数（OP_SERVICE_ACCOUNT_TOKEN・OP_CONNECT_* など）は全部外す
// （大文字小文字は区別しない）。あると、1Password の許可の画面を出さずに値が出るため。KS1P_OP_CMD は渡す。
export function childEnv(env, opCmd) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^op_/i.test(k)) continue;
    out[k] = v;
  }
  if (opCmd) out.KS1P_OP_CMD = JSON.stringify(opCmd);
  return out;
}

// 戻り値: {status:"ok", username, password, urls} か {status:"denied"|"timeout"|"not_found"|"error"}
export function requestCredentials({ item, vault = "", account = "", timeoutMs, opCmd, env = process.env }) {
  return new Promise((resolve) => {
    const args = [OP_CHILD, item];
    if (vault) args.push("--vault", vault);
    if (account) args.push("--account", account);
    args.push("--timeout-ms", String(timeoutMs));
    let child;
    try {
      child = spawn(process.execPath, args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
        cwd: safeCwd(),
        env: childEnv(env, opCmd),
      });
    } catch {
      resolve({ status: "error" });
      return;
    }
    running.add(child);
    const chunks = [];
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      resolve(r);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ status: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (d) => chunks.push(d));
    child.on("error", () => {
      running.delete(child);
      finish({ status: "error" });
    });
    child.on("close", (code) => {
      running.delete(child);
      if (settled) return;
      if (code === 0) {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (typeof j.password !== "string") return finish({ status: "error" });
          return finish({
            status: "ok",
            username: typeof j.username === "string" ? j.username : "",
            password: j.password,
            urls: Array.isArray(j.urls) ? j.urls.filter((u) => typeof u === "string") : [],
          });
        } catch {
          return finish({ status: "error" });
        }
      }
      if (code === 3) return finish({ status: "denied" });
      if (code === 4) return finish({ status: "not_found" });
      finish({ status: "error" });
    });
  });
}
