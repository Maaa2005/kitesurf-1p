import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requestCredentials } from "../../src/provider.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_OP = path.resolve(HERE, "..", "fake-op.mjs");
const OP_CMD = [process.execPath, FAKE_OP];

// 合成の値（毎回作り直す）
const rnd = (n) => Array.from({ length: n }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const USER = `user-${rnd(8)}`;
const PASS = `${rnd(10)}!#$%パス${rnd(8)}`;
const ITEM = "kitesurf-1p-test";

function setup(behavior) {
  const dir = mkdtempSync(path.join(tmpdir(), "ks1p-unit-"));
  const item = {
    id: "fakeid",
    title: ITEM,
    category: "LOGIN",
    urls: [{ primary: true, href: "http://127.0.0.1:9921" }],
    fields: [
      { id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: USER },
      { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: PASS },
    ],
  };
  writeFileSync(path.join(dir, "items.json"), JSON.stringify({ [ITEM]: item }));
  if (behavior) writeFileSync(path.join(dir, "behavior.json"), JSON.stringify(behavior));
  return {
    dir,
    env: { ...process.env, FAKE_OP_DIR: dir },
    calls: () => {
      const f = path.join(dir, "calls.log");
      if (!existsSync(f)) return [];
      return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

const ask = (env, over = {}) => requestCredentials({ item: ITEM, timeoutMs: 20000, opCmd: OP_CMD, env, ...over });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDead(pids, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pids.every((p) => !alive(p))) return true;
    await sleep(100);
  }
  return false;
}

test("ok: ID・パスワード・住所を受け取る", async () => {
  const s = setup();
  const r = await ask(s.env);
  assert.equal(r.status, "ok");
  assert.equal(r.username, USER);
  assert.equal(r.password, PASS);
  assert.deepEqual(r.urls, ["http://127.0.0.1:9921"]);
  assert.equal(s.calls().length, 1);
  assert.equal(s.calls()[0].item, ITEM);
});

test("ok: delayMs の間待ってから受け取る", async () => {
  const s = setup({ mode: "ok", delayMs: 600 });
  const t0 = Date.now();
  const r = await ask(s.env);
  assert.equal(r.status, "ok");
  assert.ok(Date.now() - t0 >= 550);
});

test("deny: denied", async () => {
  const s = setup({ mode: "deny" });
  const r = await ask(s.env);
  assert.deepEqual(r, { status: "denied" });
});

test("error: error（op の文は返さない）", async () => {
  const s = setup({ mode: "error" });
  const r = await ask(s.env);
  assert.deepEqual(r, { status: "error" });
});

test("項目なし: not_found", async () => {
  const s = setup();
  const r = await ask(s.env, { item: "no-such-item" });
  assert.deepEqual(r, { status: "not_found" });
});

test("--vault・--account を op に渡して呼べる", async () => {
  const s = setup();
  const r = await ask(s.env, { vault: "Private", account: "me" });
  assert.equal(r.status, "ok");
});

// Windows は終わったプロセスの番号をすぐ使い回すので、続けて 2 回呼ぶだけでは ppid が同じになる事がある
// （実際に起きた）。そこで 2 回を重ねて呼び、両方の子が同時に生きている間は番号が必ず違う事で確かめる。
test("login 2 回で、偽の op を呼んだ親（op-child）の番号が毎回違う（重ねて呼ぶ）", async () => {
  const s = setup({ mode: "ok", delayMs: 800 });
  const [a, b] = await Promise.all([ask(s.env), ask(s.env)]);
  assert.equal(a.status, "ok");
  assert.equal(b.status, "ok");
  const c = s.calls();
  assert.equal(c.length, 2);
  assert.notEqual(c[0].ppid, c[1].ppid);
  assert.notEqual(c[0].ppid, process.pid);
  assert.notEqual(c[1].ppid, process.pid);
  assert.notEqual(c[0].pid, c[1].pid);
});

test("login を続けて 2 回: 毎回 op を呼び直し、呼んだ親は試験の本体ではなく、終わったら残らない", async () => {
  const s = setup();
  assert.equal((await ask(s.env)).status, "ok");
  assert.equal((await ask(s.env)).status, "ok");
  const c = s.calls();
  assert.equal(c.length, 2);
  for (const x of c) assert.notEqual(x.ppid, process.pid);
  assert.ok(await waitDead([c[0].ppid, c[0].pid, c[1].ppid, c[1].pid]), "子が残っている");
});

test("timeout: 打ち切って timeout を返し、子（op-child）と孫（偽の op）が止まる", async () => {
  const s = setup({ mode: "timeout" });
  const t0 = Date.now();
  const r = await ask(s.env, { timeoutMs: 2500 });
  assert.deepEqual(r, { status: "timeout" });
  assert.ok(Date.now() - t0 < 10000);
  const c = s.calls();
  assert.equal(c.length, 1, "偽の op は呼ばれていた");
  const grandchild = c[0].pid;
  const child = c[0].ppid;
  assert.notEqual(child, process.pid);
  assert.ok(await waitDead([child, grandchild]), "子と孫が残っている");
});

// ---- 3. 子へ渡す環境から OP_ で始まる変数を外す ----
import { childEnv, killAllChildren, runningChildCount } from "../../src/provider.mjs";
import { spawnSync, spawn } from "node:child_process";
import { safeCwd } from "../../src/proc.mjs";

test("3: childEnv は OP_ で始まる変数を全部外す（大文字小文字を区別しない）。KS1P_OP_CMD は渡す", () => {
  const env = {
    PATH: "x",
    OP_SERVICE_ACCOUNT_TOKEN: "t",
    OP_CONNECT_HOST: "h",
    OP_CONNECT_TOKEN: "t",
    op_session_my: "s",
    Op_Anything: "a",
    OPX: "keep",
    XOP_Y: "keep",
    KS1P_OP_CMD: "old",
  };
  const out = childEnv(env, ["fake", "a"]);
  assert.deepEqual(Object.keys(out).sort(), ["KS1P_OP_CMD", "OPX", "PATH", "XOP_Y"]);
  assert.equal(out.KS1P_OP_CMD, JSON.stringify(["fake", "a"]));
  // opCmd が無い時は元の KS1P_OP_CMD をそのまま渡す
  assert.equal(childEnv(env, undefined).KS1P_OP_CMD, "old");
});

test("3: 偽の op が受け取った環境に OP_ で始まる変数は 0 個（calls.log）", async () => {
  const s = setup();
  const env = {
    ...s.env,
    OP_SERVICE_ACCOUNT_TOKEN: "dummy-token-1",
    OP_CONNECT_HOST: "http://localhost:1",
    OP_CONNECT_TOKEN: "dummy-token-2",
    op_lower_case: "x",
    Op_Mixed: "y",
  };
  const r = await ask(env);
  assert.equal(r.status, "ok");
  const c = s.calls();
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].opEnvNames, []);
  // 値は calls.log に書かない
  assert.ok(!readFileSync(path.join(s.dir, "calls.log"), "utf8").includes("dummy-token"));
});

test("3: 対照: 偽の op を直接呼んで OP_ の変数があれば、その名前（値は無し）が calls.log に出る", () => {
  const s = setup();
  const r = spawnSync(process.execPath, [FAKE_OP, "item", "get", ITEM, "--format", "json", "--reveal"], {
    env: { ...s.env, OP_SERVICE_ACCOUNT_TOKEN: "dummy-token-3", op_x: "1", NOT_OP: "2" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  const names = s.calls()[0].opEnvNames.map((n) => n.toUpperCase()).sort();
  assert.deepEqual(names, ["OP_SERVICE_ACCOUNT_TOKEN", "OP_X"]);
  assert.ok(!readFileSync(path.join(s.dir, "calls.log"), "utf8").includes("dummy-token"));
});

// ---- 2b. 安全な作業フォルダ ----
test("2b: op-child（と、そこから呼ぶ op）は安全な作業フォルダで動く（Windows は System32、他は /）", async () => {
  const s = setup();
  const r = await ask(s.env);
  assert.equal(r.status, "ok");
  const cwd = s.calls()[0].cwd;
  assert.equal(path.resolve(cwd).toLowerCase(), path.resolve(safeCwd()).toLowerCase());
  assert.notEqual(path.resolve(cwd).toLowerCase(), path.resolve(process.cwd()).toLowerCase());
});

// ---- 13a. 入力係の終了で子を止める ----
test("13a: killAllChildren で、動いている op-child と孫の op が止まり、結果は error", async () => {
  const s = setup({ mode: "timeout" });
  const p = ask(s.env, { timeoutMs: 60000 });
  const t0 = Date.now();
  while (s.calls().length === 0 && Date.now() - t0 < 10000) await sleep(100);
  assert.equal(s.calls().length, 1, "偽の op が呼ばれていた");
  assert.equal(runningChildCount(), 1);
  const { pid, ppid } = s.calls()[0];
  killAllChildren();
  const r = await p;
  assert.deepEqual(r, { status: "error" });
  assert.ok(await waitDead([pid, ppid]), "子と孫が残っている");
  assert.equal(runningChildCount(), 0);
});

// ---- 13c. op-child 自身の時間切れ ----
const OP_CHILD = path.resolve(HERE, "..", "..", "src", "op-child.mjs");

test("13c: op-child は親の待つ長さ（引数）より少し長く待って、孫の op を止めて終了コード 5", async () => {
  const s = setup({ mode: "timeout" });
  const env = { ...s.env, KS1P_OP_CMD: JSON.stringify(OP_CMD) };
  const child = spawn(process.execPath, [OP_CHILD, ITEM, "--timeout-ms", "600"], { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const t0 = Date.now();
  const code = await new Promise((res) => child.on("close", res));
  const ms = Date.now() - t0;
  assert.equal(code, 5);
  assert.ok(ms >= 600, `短すぎる ${ms}`);
  assert.ok(ms < 15000, `長すぎる ${ms}`);
  const c = s.calls();
  assert.equal(c.length, 1);
  assert.ok(await waitDead([c[0].pid]), "孫の op が残っている");
});

test("13c: provider は --timeout-ms を op-child に渡す（親の timeoutMs が 700 なら op-child も止まる）", async () => {
  const s = setup({ mode: "timeout" });
  const r = await ask(s.env, { timeoutMs: 700 });
  assert.deepEqual(r, { status: "timeout" });
  const c = s.calls();
  assert.ok(await waitDead([c[0].pid, c[0].ppid]));
});
