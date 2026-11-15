// 試験の記録係。入力係（node src/server.mjs）を子プロセスで起動し、stdio の JSON-RPC を流す。
// 行き帰りの 1 行をそのまま transcript.jsonl に足す（加工しない）。返事が届いた時刻を持つ。
// 同時に複数の呼び出しを出せる（call を await せずに続けて呼ぶ）。
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wslArgs, winToWsl } from "./wsl.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const SERVER_PATH = path.join(REPO_ROOT, "src", "server.mjs");

export class McpClient {
  #child = null;
  #buf = "";
  #pending = new Map();
  #nextId = 1;
  #transcript;
  #stderrPath;
  #closed = false;
  stderr = "";
  exited = null;
  /** 全部の呼び出しの記録（値は持たない: 名前・送った時刻・届いた時刻・順番） */
  calls = [];
  #order = 0;

  constructor({ env, transcriptPath, stderrPath, cwd = REPO_ROOT, serverPath = SERVER_PATH, label = "gate" }) {
    this.env = env;
    this.cwd = cwd;
    this.serverPath = serverPath;
    this.label = label;
    this.#transcript = transcriptPath;
    this.#stderrPath = stderrPath;
    writeFileSync(transcriptPath, "");
    writeFileSync(stderrPath, "");
  }

  #log(line) {
    appendFileSync(this.#transcript, line.endsWith("\n") ? line : line + "\n");
  }

  #send(obj) {
    const line = JSON.stringify(obj);
    this.#log(line);
    this.#child.stdin.write(line + "\n");
  }

  #onLine(line) {
    if (!line.trim()) return;
    this.#log(line);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && this.#pending.has(m.id)) {
      const p = this.#pending.get(m.id);
      this.#pending.delete(m.id);
      p.resolve({ msg: m, recvAt: Date.now() });
    }
  }

  async start() {
    this.#child = spawn(process.execPath, [this.serverPath], { env: this.env, cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (d) => {
      this.#buf += d;
      let i;
      while ((i = this.#buf.indexOf("\n")) >= 0) {
        const line = this.#buf.slice(0, i);
        this.#buf = this.#buf.slice(i + 1);
        this.#onLine(line);
      }
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (d) => {
      this.stderr += d;
      try {
        appendFileSync(this.#stderrPath, d);
      } catch {}
    });
    this.#child.on("exit", (code, sig) => {
      this.exited = { code, sig };
      for (const [, p] of this.#pending) p.resolve({ msg: { error: { message: "入力係が終わった" } }, recvAt: Date.now() });
      this.#pending.clear();
    });
    this.#child.on("error", () => {});
    const init = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ks1p-leak-test", version: "0" },
    });
    if (!init.msg.result) throw new Error("initialize に失敗");
    this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return this;
  }

  rpc(method, params, timeoutMs = 120000) {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) resolve({ msg: { error: { message: "返事が来ない（打ち切り）" } }, recvAt: Date.now() });
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** 道具を呼ぶ。待たずに続けて呼べば同時に出る。 */
  call(name, args = {}, { timeoutMs = 120000 } = {}) {
    const sentAt = Date.now();
    const order = ++this.#order;
    const rec = { order, name, sentAt, recvAt: null };
    this.calls.push(rec);
    return this.rpc("tools/call", { name, arguments: args }, timeoutMs).then(({ msg, recvAt }) => {
      rec.recvAt = recvAt;
      const result = msg.result ?? { isError: true, content: [{ type: "text", text: `rpc error: ${msg.error?.message ?? "unknown"}` }] };
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const img = content.find((c) => c.type === "image");
      return {
        name,
        order,
        sentAt,
        recvAt,
        ms: recvAt - sentAt,
        result,
        isError: !!result.isError || !msg.result,
        text,
        image: img ? Buffer.from(img.data, "base64") : null,
        rpcError: msg.error ? true : false,
      };
    });
  }

  /** login の返事の JSON（[TEST: guard disabled] の頭は外す）。読めなければ null。 */
  static parseLogin(r) {
    try {
      return JSON.parse(r.text.replace(/^\[TEST: guard disabled\]\n/, ""));
    } catch {
      return null;
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const c = this.#child;
    if (!c) return;
    const done = new Promise((r) => (c.exitCode !== null || this.exited ? r() : c.once("exit", () => r())));
    try {
      c.stdin.end();
    } catch {}
    const t = setTimeout(() => {
      try {
        c.kill();
      } catch {}
    }, 4000);
    await Promise.race([done, new Promise((r) => setTimeout(r, 6000))]);
    clearTimeout(t);
  }
}

// ---- 試験用のサイト（WSL の Node 22。test/site/server.mjs）の起動と出し入れ ----
export const SITE_A = "http://127.0.0.1:9921";
export const SITE_B = "http://127.0.0.1:9922";
const SITE_SCRIPT = path.join(REPO_ROOT, "test", "site", "server.mjs");

export async function startTestSite() {
  const SITE_SCRIPT_WSL = winToWsl(SITE_SCRIPT);
  try {
    await fetch(`${SITE_A}/__records`, { signal: AbortSignal.timeout(1500) });
    throw new Error("9921 に別のサーバーが居る（試験用のサイトを起動できない）");
  } catch (e) {
    if (String(e?.message).startsWith("9921")) throw e;
  }
  const child = spawn("wsl.exe", wslArgs("node", SITE_SCRIPT_WSL), { stdio: ["pipe", "pipe", "pipe"] });
  let exited = false;
  child.on("exit", () => (exited = true));
  child.on("error", () => (exited = true));
  child.stderr.setEncoding("utf8");
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("ready")) resolve();
    });
    child.on("exit", () => reject(new Error(`試験用のサイトが起動しない: ${err.slice(0, 200)}`)));
    setTimeout(() => reject(new Error("試験用のサイトの起動が 30 秒で終わらない")), 30000);
  });
  // Windows から見えるまで待つ（WSL の転送が少し遅れる）
  for (let i = 0; ; i++) {
    try {
      await fetch(`${SITE_A}/__records`, { signal: AbortSignal.timeout(1500) });
      await fetch(`${SITE_B}/__records`, { signal: AbortSignal.timeout(1500) });
      break;
    } catch {
      if (i > 40) throw new Error("試験用のサイトに Windows からつながらない");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const get = async (port) => (await fetch(`http://127.0.0.1:${port}/__records`)).json();
  return {
    records: async () => get(9921),
    reset: async () => {
      await fetch(`${SITE_A}/__reset`, { method: "POST" });
    },
    async stop() {
      try {
        child.stdin.end();
      } catch {}
      await Promise.race([new Promise((r) => (exited ? r() : child.once("exit", r))), new Promise((r) => setTimeout(r, 4000))]);
      if (!exited) {
        try {
          child.kill();
        } catch {}
        // 標準入力の終わりが届かなかった時の後始末（このサイトの node だけ）
        spawn("wsl.exe", wslArgs("pkill", "-f", "test/site/server.mjs"), { stdio: "ignore" });
      }
    },
    get exited() {
      return exited;
    },
  };
}
