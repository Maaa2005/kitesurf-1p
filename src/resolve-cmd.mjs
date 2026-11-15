// op を呼ぶ命令の先頭（実行ファイル）を、絶対の住所にする。
// 名前だけ（住所を含まない）なら、PATH の中の「絶対の住所のフォルダ」だけから探す。
// 空の要素・相対の要素・作業フォルダは見ない（Windows は作業フォルダを先に探すため、偽の op.exe を置かれる）。
// 戻り値: 絶対の住所。見つからない・相対の住所なら null。
import path from "node:path";
import { statSync, accessSync, constants } from "node:fs";

const WIN_ABS = /^[A-Za-z]:[\\/]/;
const WIN_RUNNABLE = new Set([".exe", ".com"]); // shell なしで直接起こせる物だけ

export function hasAddress(name, platform = process.platform) {
  if (name.includes("/") || name.includes("\\")) return true;
  return platform === "win32" && name.includes(":");
}

export function resolveCommand(name, { env = process.env, platform = process.platform } = {}) {
  if (typeof name !== "string" || name === "") return null;
  const win = platform === "win32";
  const P = win ? path.win32 : path.posix;
  if (hasAddress(name, platform)) return win ? (WIN_ABS.test(name) ? name : null) : P.isAbsolute(name) ? name : null;

  const pathKey = Object.keys(env).find((k) => (win ? k.toLowerCase() === "path" : k === "PATH"));
  const rawPath = pathKey ? env[pathKey] : "";
  if (typeof rawPath !== "string" || rawPath === "") return null;
  const dirs = rawPath
    .split(win ? ";" : ":")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter((d) => d !== "" && (win ? WIN_ABS.test(d) : P.isAbsolute(d)));

  let candidates = [name];
  if (win) {
    const extKey = Object.keys(env).find((k) => k.toLowerCase() === "pathext");
    let exts = String(extKey ? env[extKey] : ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => WIN_RUNNABLE.has(e));
    if (exts.length === 0) exts = [".com", ".exe"];
    candidates = WIN_RUNNABLE.has(P.extname(name).toLowerCase()) ? [name] : exts.map((e) => name + e);
  }
  for (const d of dirs) {
    for (const c of candidates) {
      const full = P.join(d, c);
      try {
        if (!statSync(full).isFile()) continue;
        if (!win) accessSync(full, constants.X_OK);
        return full;
      } catch {}
    }
  }
  return null;
}
