// 子プロセスまわりの共通の道具: Windows の標準の場所（%SystemRoot%）の絶対の住所・安全な作業フォルダ・子の木ごと止める処理。
// 実行ファイルを名前だけで呼ぶと、Windows は作業フォルダから先に探す。AI のプロジェクトのフォルダに偽物を置かれる道を塞ぐ。
import path from "node:path";
import { spawnSync } from "node:child_process";

const DRIVE_ABS = /^[A-Za-z]:[\\/]/;

// %SystemRoot%。環境変数が無い・絶対の住所でない時は C:\Windows。
export function systemRoot(env = process.env) {
  for (const k of ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"]) {
    const v = env[k];
    if (typeof v === "string" && DRIVE_ABS.test(v)) return v.replace(/[\\/]+$/, "");
  }
  return "C:\\Windows";
}

export const taskkillPath = (env = process.env) => path.win32.join(systemRoot(env), "System32", "taskkill.exe");
export const powershellPath = (env = process.env) =>
  path.win32.join(systemRoot(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

// op-child を起こす作業フォルダ（Windows は %SystemRoot%\System32、他は /）。
export function safeCwd(platform = process.platform, env = process.env) {
  return platform === "win32" ? path.win32.join(systemRoot(env), "System32") : "/";
}

const defaultAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// pid の木ごと止める。止められずまだ生きている時は stderr に 1 行（値は書かない）。戻り値: 止まった（か、もう居ない）か。
// group: 非 Windows で、プロセスグループごと止めるか（detached で起こした子だけ true）。
export function killProcessTree(
  pid,
  { platform = process.platform, group = true, env = process.env, spawnSyncFn = spawnSync, killFn = process.kill, isAlive = defaultAlive, stderr = process.stderr } = {},
) {
  if (pid === undefined || pid === null) return true;
  const warn = () => {
    try {
      stderr.write(`子プロセスを止められなかった（pid ${pid}）\n`);
    } catch {}
  };
  try {
    if (platform === "win32") {
      const r = spawnSyncFn(taskkillPath(env), ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
      if (r && !r.error && r.status === 0) return true;
      if (!isAlive(pid)) return true; // もう終わっていた
      warn();
      return false;
    }
    try {
      if (group) killFn(-pid, "SIGKILL");
      else killFn(pid, "SIGKILL");
      return true;
    } catch {
      try {
        killFn(pid, "SIGKILL");
        return true;
      } catch {
        if (!isAlive(pid)) return true;
        warn();
        return false;
      }
    }
  } catch {
    if (!isAlive(pid)) return true;
    warn();
    return false;
  }
}
