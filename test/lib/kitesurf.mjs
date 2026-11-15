// Kitesurf の番号（ポート）まわりの共通の道具。
//   KS1P_KITESURF_WS  入力係が読む CDP の住所（既定 ws://127.0.0.1:8787/devtools/browser）
//   KITESURF_PORT     Kitesurf 本体が読む番号（既定 8787）。番号を変える時は両方をそろえる。
export const DEFAULT_WS = "ws://127.0.0.1:8787/devtools/browser";
export const DEFAULT_HEALTH_URL = "http://127.0.0.1:8787/health";

function parseWs(env) {
  const ws = env.KS1P_KITESURF_WS;
  if (!ws) return null;
  try {
    const u = new URL(ws);
    if (!u.hostname) return null;
    return u;
  } catch {
    return null;
  }
}

/** 健康確認の住所。KS1P_KITESURF_WS があればその host と port から作る（無ければ既定）。 */
export function kitesurfHealthUrl(env = process.env) {
  const u = parseWs(env);
  if (!u) return DEFAULT_HEALTH_URL;
  const port = u.port || "80";
  return `http://${u.hostname}:${port}/health`; // IPv6 の hostname は [ ] 付きで返る
}

/** WSL の台本へ渡す KITESURF_PORT。KITESURF_PORT があればそれ、無ければ KS1P_KITESURF_WS の port。無ければ null。 */
export function kitesurfPortForScript(env = process.env) {
  if (env.KITESURF_PORT) return String(env.KITESURF_PORT);
  const u = parseWs(env);
  return u && u.port ? u.port : null;
}
