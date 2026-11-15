// Windows のトースト通知。文は環境変数で渡し、XML として逃がす。失敗しても止めない。
import { spawn } from "node:child_process";
import { powershellPath, safeCwd } from "./proc.mjs";

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$title = [System.Security.SecurityElement]::Escape($env:KS1P_NOTIFY_TITLE)
$body = [System.Security.SecurityElement]::Escape($env:KS1P_NOTIFY_BODY)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast scenario='reminder'><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
`;

// 戻り値: "sent" | "skipped" | "failed"
export async function notify({ enabled, title, body, timeoutMs = 10000 }) {
  if (!enabled) return "skipped";
  if (process.platform !== "win32") return "failed";
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    try {
      const encoded = Buffer.from(PS_SCRIPT, "utf16le").toString("base64");
      const child = spawn(powershellPath(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        stdio: "ignore",
        windowsHide: true,
        cwd: safeCwd(),
        env: { ...process.env, KS1P_NOTIFY_TITLE: String(title), KS1P_NOTIFY_BODY: String(body) },
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish("failed");
      }, timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        finish("failed");
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        finish(code === 0 ? "sent" : "failed");
      });
    } catch {
      finish("failed");
    }
  });
}
