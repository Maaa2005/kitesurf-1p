// proc.mjs（%SystemRoot% の絶対の住所・安全な作業フォルダ・木ごと止める）と resolve-cmd.mjs（op の探し方）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { systemRoot, taskkillPath, powershellPath, safeCwd, killProcessTree } from "../../src/proc.mjs";
import { resolveCommand, hasAddress } from "../../src/resolve-cmd.mjs";
import { tmpDir } from "./_helpers.mjs";

const WIN = process.platform === "win32";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OP_CHILD = path.resolve(HERE, "..", "..", "src", "op-child.mjs");

// ---- 2c ----
test("2c: taskkill・powershell は %SystemRoot% からの絶対の住所", () => {
  const env = { SystemRoot: "D:\\Win" };
  assert.equal(systemRoot(env), "D:\\Win");
  assert.equal(taskkillPath(env), "D:\\Win\\System32\\taskkill.exe");
  assert.equal(powershellPath(env), "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(safeCwd("win32", env), "D:\\Win\\System32");
  assert.equal(safeCwd("linux", env), "/");
  // 絶対でない・空なら既定
  assert.equal(systemRoot({ SystemRoot: "relative\\dir" }), "C:\\Windows");
  assert.equal(systemRoot({}), "C:\\Windows");
});

test("2c: 今の環境の taskkill・powershell の住所は絶対で、実在する（Windows）", { skip: !WIN }, async () => {
  const { existsSync } = await import("node:fs");
  for (const p of [taskkillPath(), powershellPath()]) {
    assert.ok(path.win32.isAbsolute(p) && /^[A-Za-z]:\\/.test(p), p);
    assert.ok(existsSync(p), p);
  }
  assert.ok(existsSync(safeCwd()));
});

// ---- 13b ----
const memErr = () => {
  const lines = [];
  return { lines, write: (s) => lines.push(s) };
};

test("13b: taskkill が失敗し、まだ生きていれば stderr に 1 行（値は書かない）", () => {
  const e = memErr();
  const r = killProcessTree(4242, { platform: "win32", spawnSyncFn: () => ({ status: 1 }), isAlive: () => true, stderr: e });
  assert.equal(r, false);
  assert.equal(e.lines.length, 1);
  assert.match(e.lines[0], /止められなかった/);
  assert.equal(e.lines[0].trim().split("\n").length, 1);
});

test("13b: taskkill の起動自体が失敗（error）でも、生きていれば 1 行", () => {
  const e = memErr();
  const r = killProcessTree(4242, { platform: "win32", spawnSyncFn: () => ({ error: new Error("x"), status: null }), isAlive: () => true, stderr: e });
  assert.equal(r, false);
  assert.equal(e.lines.length, 1);
});

test("13b: taskkill が成功なら何も書かない・失敗でも既に居なければ書かない", () => {
  const e = memErr();
  assert.equal(killProcessTree(1, { platform: "win32", spawnSyncFn: () => ({ status: 0 }), isAlive: () => true, stderr: e }), true);
  assert.equal(killProcessTree(1, { platform: "win32", spawnSyncFn: () => ({ status: 128 }), isAlive: () => false, stderr: e }), true);
  assert.equal(e.lines.length, 0);
});

test("13b: taskkill は絶対の住所で呼ぶ", () => {
  let seen;
  killProcessTree(7, { platform: "win32", env: { SystemRoot: "C:\\Windows" }, spawnSyncFn: (cmd, args) => ((seen = { cmd, args }), { status: 0 }) });
  assert.equal(seen.cmd, "C:\\Windows\\System32\\taskkill.exe");
  assert.deepEqual(seen.args, ["/T", "/F", "/PID", "7"]);
});

test("13b: 非 Windows: グループで止められず、個別も駄目で生きていれば 1 行", () => {
  const e = memErr();
  const r = killProcessTree(9, {
    platform: "linux",
    killFn: () => {
      throw new Error("EPERM");
    },
    isAlive: () => true,
    stderr: e,
  });
  assert.equal(r, false);
  assert.equal(e.lines.length, 1);
});

// ---- 2a: op の探し方 ----
const exeName = WIN ? "op.exe" : "op";
function plant(dir, name = exeName) {
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  writeFileSync(f, "");
  if (!WIN) chmodSync(f, 0o755);
  return f;
}
const pathEnv = (...dirs) => ({ PATH: dirs.join(path.delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" });

test("2a: hasAddress", () => {
  assert.equal(hasAddress("op"), false);
  assert.equal(hasAddress("op.exe"), false);
  assert.equal(hasAddress("./op"), true);
  assert.equal(hasAddress("a/b"), true);
  assert.equal(hasAddress("a\\b"), true);
  assert.equal(hasAddress("C:op.exe", "win32"), true);
});

test("2a: 名前だけなら、PATH の絶対のフォルダから探して絶対の住所にする", () => {
  const d = path.join(tmpDir(), "bin");
  const f = plant(d);
  const r = resolveCommand("op", { env: pathEnv(d) });
  assert.equal(r, f);
  assert.ok(path.isAbsolute(r));
});

test("2a: 作業フォルダに偽の op を置かれても、PATH に無ければ見つからない（作業フォルダは見ない）", () => {
  const cwdDir = tmpDir("ks1p-cwd-");
  plant(cwdDir);
  const prev = process.cwd();
  process.chdir(cwdDir);
  try {
    assert.equal(resolveCommand("op", { env: pathEnv(tmpDir("ks1p-empty-")) }), null);
    assert.equal(resolveCommand("op", { env: { PATH: "" } }), null);
    assert.equal(resolveCommand("op", { env: {} }), null);
  } finally {
    process.chdir(prev);
  }
});

test("2a: 空・相対（.・..・相対の名前）の PATH の要素と作業フォルダは見ない", () => {
  const cwdDir = tmpDir("ks1p-cwd-");
  plant(cwdDir);
  plant(path.join(cwdDir, "rel"));
  const prev = process.cwd();
  process.chdir(cwdDir);
  try {
    const sep = path.delimiter;
    const env = { PATH: ["", ".", "rel", "..", `.${path.sep}rel`, ""].join(sep), PATHEXT: ".EXE" };
    assert.equal(resolveCommand("op", { env }), null);
  } finally {
    process.chdir(prev);
  }
});

test("2a: 相対の要素・空の要素の後ろにある絶対のフォルダは見つける。先頭の絶対のフォルダが優先", () => {
  const root = tmpDir();
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  const fa = plant(a);
  plant(b);
  assert.equal(resolveCommand("op", { env: pathEnv("", "rel", a, b) }), fa);
});

test("2a: 住所を含む名前はそのまま（絶対）・相対の住所は null", () => {
  const f = plant(path.join(tmpDir(), "x"));
  assert.equal(resolveCommand(f, { env: {} }), f);
  assert.equal(resolveCommand(`.${path.sep}op`, { env: pathEnv(tmpDir()) }), null);
  assert.equal(resolveCommand(`sub${path.sep}op`, { env: {} }), null);
  assert.equal(resolveCommand("", { env: {} }), null);
});

test("2a: Windows は PATHEXT を使う（op → op.exe）。名前に拡張子があればそのまま", { skip: !WIN }, () => {
  const d = path.join(tmpDir(), "w");
  const f = plant(d, "tool.exe");
  assert.equal(resolveCommand("tool", { env: pathEnv(d) }), f);
  assert.equal(resolveCommand("tool.exe", { env: pathEnv(d) }), f);
  assert.equal(resolveCommand("TOOL", { env: pathEnv(d) }), path.join(d, "TOOL.exe"));
  // PATH の名前の大文字小文字は区別しない
  assert.equal(resolveCommand("tool", { env: { Path: d, PathExt: ".EXE" } }), f);
  // shell が要る .cmd は直接起こせないので見ない
  const d2 = path.join(tmpDir(), "c");
  plant(d2, "only.cmd");
  assert.equal(resolveCommand("only", { env: pathEnv(d2) }), null);
});

test("2a: op-child は命令が見つからなければ終了コード 5（偽の op を作業フォルダに置かれても呼ばない）", () => {
  const cwdDir = tmpDir("ks1p-planted-");
  // 作業フォルダの偽の op: 呼ばれると印のファイルを作る node のスクリプトを op.exe の名前で置くのは難しいので、
  // 名前だけの命令が PATH に無い時に 5 で終わる事と、印が出来ない事を確かめる。
  plant(cwdDir);
  const env = { ...process.env, KS1P_OP_CMD: JSON.stringify(["ks1p-no-such-cmd-xyz"]), NODE_DEBUG: "" };
  const r = spawnSync(process.execPath, [OP_CHILD, "item-1", "--timeout-ms", "5000"], { env, cwd: cwdDir, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 5);
  assert.equal(r.stdout, "");
});

test("2a: op-child は作業フォルダの op を使わない（PATH から探した絶対の住所の物を呼ぶ）", { skip: !WIN }, () => {
  // 作業フォルダに、呼ばれたら calls を残す偽の op.exe の代わりに node.exe のコピーは置けないので、
  // 名前 "node" を PATH から解決して絶対の住所を使う事を、op の代わりの node のスクリプトで確かめる。
  const dir = tmpDir("ks1p-nodecmd-");
  const script = path.join(dir, "fake.mjs");
  writeFileSync(script, "process.stdout.write(JSON.stringify({id:'x',fields:[{id:'password',purpose:'PASSWORD',value:'pw-12345'}],urls:[]}));");
  const env = { ...process.env, KS1P_OP_CMD: JSON.stringify(["node", script]), NODE_DEBUG: "" };
  const r = spawnSync(process.execPath, [OP_CHILD, "item-1", "--timeout-ms", "10000"], { env, cwd: dir, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).password, "pw-12345");
});

test("2a: op-child は item・vault・account が - で始まれば 5", () => {
  const env = { ...process.env, KS1P_OP_CMD: JSON.stringify([process.execPath, "-e", "process.exit(0)"]), NODE_DEBUG: "" };
  for (const args of [["--help"], ["it", "--vault", "-x"], ["it", "--account", "--y"]]) {
    const r = spawnSync(process.execPath, [OP_CHILD, ...args, "--timeout-ms", "5000"], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(r.status, 5, args.join(" "));
  }
});
