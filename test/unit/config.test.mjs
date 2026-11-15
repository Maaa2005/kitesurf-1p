// config.mjs: 1b（NODE_DEBUG）・4（試験用の切り替え）・5（期限の廃止）・9（KS1P_KITESURF_WS）・10（sites.json の "-"）
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, parseSites, nodeDebugProblem, isRepoFakeOp, parseKitesurfWs } from "../../src/config.mjs";
import { tmpDir } from "./_helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "..", "..", "src", "server.mjs");

const baseEnv = () => ({ KS1P_SITES: path.join(tmpDir(), "none.json"), KS1P_LOG_DIR: tmpDir(), NODE_DEBUG: "" });
const cfgOf = (extra) => loadConfig({ ...baseEnv(), ...extra });

// ---- 1b ----
test("1b: NODE_DEBUG が空・未設定なら問題なし", () => {
  assert.equal(nodeDebugProblem({}), null);
  assert.equal(nodeDebugProblem({ NODE_DEBUG: "" }), null);
});

test("1b: NODE_DEBUG が空でなければ理由の 1 行を返す（値は書かない）", () => {
  for (const v of ["*", "puppeteer:protocol:SEND ►", "x", " "]) {
    const m = nodeDebugProblem({ NODE_DEBUG: v });
    assert.equal(typeof m, "string");
    assert.ok(m.length > 0 && !m.includes("\n"));
    if (v.trim()) assert.ok(!m.includes(v), "NODE_DEBUG の値を出さない");
  }
});

test("1b: 起動時に NODE_DEBUG があれば、理由を stderr に 1 行書いて終了コード 1", () => {
  const r = spawnSync(process.execPath, [SERVER], { env: { ...process.env, ...baseEnv(), NODE_DEBUG: "puppeteer*" }, input: "", encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "", "stdout は MCP の通信だけ");
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.match(r.stderr, /NODE_DEBUG/);
});

// ---- 4 ----
const FAKE_OP_PATH = path.resolve(HERE, "..", "fake-op.mjs");

test("4: isRepoFakeOp はこのリポの test/fake-op.mjs そのものだけ（大文字小文字は区別しない・住所は解く）", () => {
  assert.equal(isRepoFakeOp(FAKE_OP_PATH), true);
  assert.equal(isRepoFakeOp(FAKE_OP_PATH.toUpperCase()), true);
  assert.equal(isRepoFakeOp(FAKE_OP_PATH.toLowerCase()), true);
  assert.equal(isRepoFakeOp(path.join(path.dirname(FAKE_OP_PATH), "..", "test", "fake-op.mjs")), true);
  for (const s of ["op", "op.exe", "node", process.execPath, "fake-op.mjs", path.join(tmpDir(), "fake-op.mjs"), FAKE_OP_PATH + ".bak", "", undefined]) {
    assert.equal(isRepoFakeOp(s), false, String(s));
  }
});

const TEST_ON = { KS1P_TEST_MODE: "1", KS1P_TEST_DISABLE_GUARD: "1" };
const FAKE = JSON.stringify([process.execPath, FAKE_OP_PATH]);

test("4a: 偽の op の時、KS1P_TEST_MODE=1 と KS1P_TEST_DISABLE_GUARD=1 で効く", () => {
  const c = cfgOf({ ...TEST_ON, KS1P_OP_CMD: FAKE });
  assert.equal(c.guardDisabled, true);
});

test("4a: 既定（op.exe）では効かない。警告のための印が立つ", () => {
  const c = cfgOf({ ...TEST_ON });
  assert.equal(c.guardDisabled, false);
  assert.equal(c.guardDisableRequestedWithoutFakeOp, true);
});

test("4a: fake-op.mjs そのもの以外なら効かない（本物の op・別名・ラッパー・別の場所の同名ファイル）", () => {
  const other = path.join(tmpDir(), "fake-op.mjs");
  for (const cmd of [["op"], ["C:/x/op.exe"], ["node", "/usr/bin/op"], ["wsl.exe", "op.exe"], ["C:/x/my-op-alias.exe"], [process.execPath, other], ["node", "fake-op.mjs"]]) {
    const c = cfgOf({ ...TEST_ON, KS1P_OP_CMD: JSON.stringify(cmd) });
    assert.equal(c.guardDisabled, false, cmd.join(" "));
    assert.equal(c.guardDisableRequestedWithoutFakeOp, true);
  }
});

test("4a: 命令の要素のどれかが fake-op.mjs そのものなら効く（大文字小文字違いも）", () => {
  assert.equal(cfgOf({ ...TEST_ON, KS1P_OP_CMD: JSON.stringify(["node", FAKE_OP_PATH.toUpperCase()]) }).guardDisabled, true);
});

test("4a: KS1P_TEST_MODE が無ければ効かない（今までどおり）", () => {
  const c = cfgOf({ KS1P_TEST_DISABLE_GUARD: "1", KS1P_OP_CMD: FAKE });
  assert.equal(c.guardDisabled, false);
  assert.equal(c.guardDisableRequestedWithoutTestMode, true);
});

test("4a: KS1P_TEST_DISABLE_GUARD が無ければ効かない", () => {
  const c = cfgOf({ KS1P_TEST_MODE: "1", KS1P_OP_CMD: FAKE });
  assert.equal(c.guardDisabled, false);
  assert.equal(c.guardDisableRequestedWithoutFakeOp, false);
});

test("4b: KS1P_ALLOW_HTTP_LOOPBACK は KS1P_TEST_MODE=1 の時だけ効く", () => {
  assert.equal(cfgOf({ KS1P_ALLOW_HTTP_LOOPBACK: "1" }).allowHttpLoopback, false);
  assert.equal(cfgOf({ KS1P_ALLOW_HTTP_LOOPBACK: "1" }).allowHttpLoopbackRequestedWithoutTestMode, true);
  assert.equal(cfgOf({ KS1P_ALLOW_HTTP_LOOPBACK: "1", KS1P_TEST_MODE: "1" }).allowHttpLoopback, true);
  assert.equal(cfgOf({ KS1P_TEST_MODE: "1" }).allowHttpLoopback, false);
});

test("4b: 起動した入力係は、警告を stderr に出す（TEST_MODE なしで 2 つ頼んだ時）", () => {
  const r = spawnSync(process.execPath, [SERVER], {
    env: { ...process.env, ...baseEnv(), KS1P_ALLOW_HTTP_LOOPBACK: "1", KS1P_TEST_DISABLE_GUARD: "1", KS1P_SECRET_TTL_MS: "1000" },
    input: "",
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /KS1P_ALLOW_HTTP_LOOPBACK は KS1P_TEST_MODE=1/);
  assert.match(r.stderr, /KS1P_TEST_DISABLE_GUARD は KS1P_TEST_MODE=1/);
  assert.match(r.stderr, /KS1P_SECRET_TTL_MS は使われなくなった/);
});

test("4a: 起動した入力係は、既定の op で KS1P_TEST_DISABLE_GUARD を頼まれると警告して効かせない", () => {
  const r = spawnSync(process.execPath, [SERVER], {
    env: { ...process.env, ...baseEnv(), KS1P_TEST_MODE: "1", KS1P_TEST_DISABLE_GUARD: "1" },
    input: "",
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /test\/fake-op\.mjs が無いと効かない/);
  assert.ok(!/警告: KS1P_TEST_DISABLE_GUARD が有効/.test(r.stderr));
});

// ---- 5 ----
test("5: KS1P_SECRET_TTL_MS は読まない。設定されていれば印が立つ", () => {
  const a = cfgOf({});
  assert.equal(a.secretTtlIgnored, false);
  assert.ok(!("secretTtlMs" in a));
  const b = cfgOf({ KS1P_SECRET_TTL_MS: "1000" });
  assert.equal(b.secretTtlIgnored, true);
  assert.ok(!("secretTtlMs" in b));
  // 変な値でも誤りにならない（読まないため）
  assert.equal(cfgOf({ KS1P_SECRET_TTL_MS: "abc" }).secretTtlIgnored, true);
});

// ---- 9 ----
test("9: KS1P_KITESURF_WS は ws: で 127.0.0.1・::1・localhost だけ", () => {
  for (const ok of ["ws://127.0.0.1:8787/devtools/browser", "ws://localhost:9000/x", "ws://[::1]:8787/devtools/browser", "WS://LOCALHOST:1/x"]) {
    assert.doesNotThrow(() => cfgOf({ KS1P_KITESURF_WS: ok }), ok);
  }
  assert.equal(cfgOf({}).kitesurfWs, "ws://127.0.0.1:8787/devtools/browser");
});

test("9: wss・http・ほかのホスト・ユーザー付き・形が変なものは設定の誤り", () => {
  for (const bad of [
    "wss://127.0.0.1:8787/x",
    "http://127.0.0.1:8787/x",
    "ws://example.com:8787/x",
    "ws://127.0.0.1.evil.com:8787/x",
    "ws://localhost.evil.com/x",
    "ws://127.0.0.2:8787/x",
    "ws://0.0.0.0:8787/x",
    "ws://user:pw@127.0.0.1:8787/x",
    "ws://127.0.0.1@evil.com:8787/x",
    "ws://[::2]:8787/x",
    "not a url",
  ]) {
    assert.throws(() => cfgOf({ KS1P_KITESURF_WS: bad }), /KS1P_KITESURF_WS/, bad);
    assert.throws(() => parseKitesurfWs(bad), /KS1P_KITESURF_WS/, bad);
  }
});

test("9: 起動時に止まる（設定の誤りで終了コード 2）", () => {
  const r = spawnSync(process.execPath, [SERVER], { env: { ...process.env, ...baseEnv(), KS1P_KITESURF_WS: "ws://evil.example:8787/x" }, input: "", encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /設定の誤り.*KS1P_KITESURF_WS/);
});

// ---- 10 ----
const site = (op) => ({ name: "a", origin: "https://example.com", op });

test("10: op.item・op.vault・op.account が - で始まれば読み込みの誤り", () => {
  for (const k of ["item", "vault", "account"]) {
    for (const v of ["-x", "--vault", "-", " -x"]) {
      const op = { item: "ok-item", [k]: v };
      assert.throws(() => parseSites([site(op)]), new RegExp(`op\\.${k}`), `${k}=${v}`);
    }
  }
});

test("10: - が途中にある名前や普通の名前は通る", () => {
  const s = parseSites([site({ item: "my-item-1", vault: "Private-2", account: "me-x.1password.com" })]);
  assert.equal(s[0].op.item, "my-item-1");
  assert.equal(s[0].op.vault, "Private-2");
});

test("10: sites.json を読む loadConfig でも誤りになる", () => {
  const f = path.join(tmpDir(), "sites.json");
  writeFileSync(f, JSON.stringify([site({ item: "--help" })]));
  assert.throws(() => loadConfig({ KS1P_SITES: f, KS1P_LOG_DIR: tmpDir() }), /サイト一覧を読めない.*op\.item/);
});
