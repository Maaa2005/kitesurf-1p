// 試験用のサイト。依存なし。WSL の Node 22 で動かす:
//   node <リポの住所>/test/site/server.mjs
// 127.0.0.1:9921（A）と 127.0.0.1:9922（B）の両方で待つ。受けた要求を覚え、
// GET /__records で出し、POST /__reset で空にする。受けた中身を stdout に出さない。
// 標準入力が閉じたら終わる。
import http from "node:http";

const HOST = "127.0.0.1";
const PORT_A = 9921;
const PORT_B = 9922;
const MAX_BODY = 1024 * 1024;

const records = [];
let seq = 0;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page({ title, body, head = "", script = "" }) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font-family:sans-serif;margin:24px;background:#fff;color:#000}
input{font-size:18px;margin:4px 0;padding:4px;width:360px}
button{font-size:18px;padding:4px 16px;margin-top:8px}
.big h1{font-size:44px}
.big label{font-size:28px;display:block}
.big input{font:32px monospace;width:620px;padding:6px}
.big button{font-size:30px}
#result{font-size:28px}
</style>${head}</head>
<body>
${body}
${script ? `<script>\n${script}\n</script>` : ""}
</body></html>`;
}

// ログインの画面。opt: {title, heading, method, action, noButton, big, js, second}
function loginPage(opt) {
  const method = opt.method === undefined ? "" : ` method="${opt.method}"`;
  const action = opt.action === undefined ? "" : ` action="${opt.action}"`;
  const second = opt.second ? `<label for="password2">確認用パスワード</label><br><input id="password2" name="password2" type="password" autocomplete="off"><br>` : "";
  const button = opt.noButton ? "" : `<button id="submit" type="submit">ログイン</button>`;
  const body = `<div class="${opt.big ? "big" : ""}">
<h1>${esc(opt.heading ?? opt.title)}</h1>
<form id="f"${method}${action}>
<label for="username">ユーザー名</label><br>
<input id="username" name="username" type="text" autocomplete="off"><br>
<label for="password">パスワード</label><br>
<input id="password" name="password" type="password" autocomplete="off"><br>
${second}${button}
</form>
<p id="result"></p>
</div>`;
  const jsSubmit = `
document.getElementById("f").addEventListener("submit", function (e) {
  e.preventDefault();
  var payload = JSON.stringify({
    username: document.getElementById("username").value,
    password: document.getElementById("password").value
  });
  fetch("/api/login-js", { method: "POST", headers: { "content-type": "application/json" }, body: payload })
    .then(function (r) { return r.json(); })
    .then(function (j) { document.getElementById("result").textContent = j.ok ? "結果: 受け取りました" : "結果: 失敗"; })
    .catch(function () { document.getElementById("result").textContent = "結果: 通信できない"; });
});`;
  return page({ title: opt.title, body, script: [opt.js ? jsSubmit : "", opt.script ?? ""].join("\n") });
}

const landing = () =>
  page({ title: "着地", body: `<h1>LANDING</h1><p id="msg">着地の画面です</p>` });

const PAGES = {
  "/login-post": () => loginPage({ title: "ログイン POST", heading: "LOGIN POST", method: "post", action: "/login-post" }),
  "/login-js": () => loginPage({ title: "ログイン JS", heading: "LOGIN JS", method: "post", action: "/login-js", js: true }),
  "/login-enter": () => loginPage({ title: "ログイン ENTER", heading: "LOGIN ENTER", method: "post", action: "/login-enter", noButton: true }),
  "/login-js-big": () =>
    loginPage({ title: "ログイン JS BIG", heading: "BIG LOGIN PAGE", method: "post", action: "/login-js-big", js: true, big: true }),
  "/landing": landing,
  // 断る試験用
  "/login-get": () => loginPage({ title: "ログイン GET", heading: "LOGIN GET", method: "get", action: "/login-get" }),
  "/login-default-get": () => loginPage({ title: "ログイン 既定", heading: "LOGIN DEFAULT", action: "/login-default-get" }),
  "/two-passwords": () => loginPage({ title: "パスワード 2 つ", heading: "TWO PASSWORDS", method: "post", action: "/two-passwords", second: true }),
  "/no-password": () =>
    page({
      title: "パスワード無し",
      body: `<h1>NO PASSWORD</h1><form id="f" method="post" action="/no-password"><label for="username">ユーザー名</label><br><input id="username" name="username" type="text"><br><button type="submit">次へ</button></form>`,
    }),
  "/iframe-cross": () =>
    page({
      title: "iframe 別 origin",
      body: `<h1>IFRAME CROSS</h1><iframe id="fr" src="http://127.0.0.1:${PORT_B}/login-post" width="520" height="420"></iframe>`,
    }),
  "/iframe-same": () =>
    page({
      title: "iframe 同じ origin",
      body: `<h1>IFRAME SAME</h1><iframe id="fr" src="http://127.0.0.1:${PORT_A}/login-post" width="520" height="420"></iframe>`,
    }),
  "/action-other": () =>
    loginPage({ title: "送り先が B", heading: "ACTION OTHER", method: "post", action: `http://127.0.0.1:${PORT_B}/login-post` }),
  // 承認待ちの割り込み用
  "/change-during-approval": () =>
    loginPage({
      title: "承認中に移る",
      heading: "CHANGE DURING APPROVAL",
      method: "post",
      action: "/login-post",
      script: `setTimeout(function () { location.href = "/landing"; }, 700);`,
    }),
  "/replace-during-approval": () =>
    loginPage({
      title: "承認中に作り直す",
      heading: "REPLACE DURING APPROVAL",
      method: "post",
      action: "/login-post",
      script: `setTimeout(function () {
  var old = document.getElementById("f");
  var nf = document.createElement("form");
  nf.id = "f";
  nf.method = "post";
  nf.action = "/login-post";
  nf.innerHTML = old.innerHTML;
  old.parentNode.replaceChild(nf, old);
}, 700);`,
    }),
};

function route(port, pathname) {
  // B は path が /login-post で終わる住所すべてにログインの画面を返す（住所の途中に A を含む試験用）
  if (port === PORT_B && pathname.endsWith("/login-post")) return PAGES["/login-post"];
  return PAGES[pathname];
}

function makeServer(port) {
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${HOST}:${port}`);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const pathname = url.pathname;
    const send = (code, type, body, extra = {}) => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...extra });
      res.end(body);
    };

    if (pathname === "/__records" && req.method === "GET") {
      send(200, "application/json; charset=utf-8", JSON.stringify(records));
      return;
    }
    if (pathname === "/__reset" && req.method === "POST") {
      records.length = 0;
      send(200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
      return;
    }

    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => {
      records.push({
        seq: ++seq,
        t: Date.now(),
        port,
        method: req.method,
        path: pathname,
        query: url.search.replace(/^\?/, ""),
        contentType: req.headers["content-type"] ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.method === "POST") {
        if (pathname === "/api/login-js") {
          send(200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
        } else {
          send(200, "text/html; charset=utf-8", landing());
        }
        return;
      }
      const make = route(port, pathname);
      if (req.method === "GET" && make) {
        send(200, "text/html; charset=utf-8", make());
        return;
      }
      send(404, "text/plain; charset=utf-8", "not found");
    });
  });
}

const servers = [makeServer(PORT_A), makeServer(PORT_B)];
let listening = 0;
for (const [i, s] of servers.entries()) {
  const port = i === 0 ? PORT_A : PORT_B;
  s.on("error", (e) => {
    process.stderr.write(`listen error: ${e.code ?? e.name}\n`);
    process.exit(1);
  });
  s.listen(port, HOST, () => {
    listening++;
    if (listening === servers.length) process.stdout.write(`ready ${PORT_A} ${PORT_B}\n`);
  });
}

// 標準入力が閉じたら終わる
const bye = () => process.exit(0);
process.stdin.on("end", bye);
process.stdin.on("close", bye);
process.stdin.on("error", bye);
process.stdin.resume();
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
