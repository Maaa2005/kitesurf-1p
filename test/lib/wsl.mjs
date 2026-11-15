// WSL まわりの共通の道具。作者の PC の住所や名前を決め打ちしない。
//   KS1P_WSL_DISTRO  WSL の distro 名（既定 Ubuntu-24.04）
//   KS1P_WSL_USER    WSL で使うユーザー（既定 root）
// リポの WSL 側の住所は決め打ちせず、必要になった時に wsl.exe の wslpath で求める（Windows だけ。Linux ではそのまま）。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WSL_DISTRO = process.env.KS1P_WSL_DISTRO || "Ubuntu-24.04";
export const WSL_USER = process.env.KS1P_WSL_USER || "root";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

/** wsl.exe に渡す引数（wsl.exe の後ろ）。`--` のあとにコマンドを続ける。 */
export const wslArgs = (...cmd) => ["-d", WSL_DISTRO, "-u", WSL_USER, "--", ...cmd];

const cache = new Map();

/** Windows の住所を WSL の中から見た住所にする。Windows 以外ではそのまま返す。 */
export function winToWsl(p) {
  if (process.platform !== "win32") return p;
  // wslpath の判定を 1 回で済ませるため、リポの中の物は求めたリポの住所の後ろにつなぐ
  const rel = path.relative(REPO, p);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return wslpathCached(REPO).replace(/\/+$/, "") + "/" + rel.split(path.sep).join("/");
  }
  return wslpathCached(p);
}

function wslpathCached(p) {
  if (cache.has(p)) return cache.get(p);
  // シェルでバックスラッシュが消えないよう、斜線にして渡す
  const r = spawnSync("wsl.exe", wslArgs("wslpath", "-a", p.split("\\").join("/")), { encoding: "utf8", windowsHide: true, timeout: 60000 });
  const out = String(r.stdout || "").trim();
  if (r.status !== 0 || !out) {
    throw new Error(`wslpath が失敗した（distro=${WSL_DISTRO}, user=${WSL_USER}）。KS1P_WSL_DISTRO・KS1P_WSL_USER を確かめる`);
  }
  cache.set(p, out);
  return out;
}

/** WSL の中の環境変数の値（無ければ空）。 */
export function wslEnv(name) {
  if (process.platform === "win32") {
    const r = spawnSync("wsl.exe", wslArgs("printenv", name), { encoding: "utf8", windowsHide: true, timeout: 60000 });
    return r.status === 0 ? String(r.stdout || "").trim() : "";
  }
  return process.env[name] || "";
}

/**
 * Kitesurf の置き場と記録の WSL 側の住所（scripts/kitesurf-dev.sh と同じ既定）。
 *   KITESURF_DIR 既定 $HOME/dev/kitesurf    KS_LOG 既定 $HOME/dev/kitesurf-dev.log
 * Windows 側の環境変数があればそれを使い、無ければ WSL の中の $HOME から作る。
 */
export function kitesurfPaths() {
  let home = null;
  const getHome = () => (home ??= wslEnv("HOME") || "/root");
  const dir = process.env.KITESURF_DIR || `${getHome()}/dev/kitesurf`;
  const log = process.env.KS_LOG || `${getHome()}/dev/kitesurf-dev.log`;
  return { dir, log, wrangler: `${dir}/packages/engine/.wrangler` };
}
