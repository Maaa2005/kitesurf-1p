import { test } from "node:test";
import assert from "node:assert/strict";
import { SecretStore } from "../../src/secret-store.mjs";
import { LeakGuard } from "../../src/leak-guard.mjs";

// 合成の値。記号・日本語・絵文字を含む。
const S = "Qx7!#$%&*+-=?@^_~\"'<>/\\パスワード🔑k9";
const ID = "user-a1B2c3D4";
const surround = (s) => `{"a":"前の文字 ${s} 後ろの文字","n":1}`;

function makeGuard(value = S, id = ID) {
  const store = new SecretStore({ ttlMs: 60000 });
  store.add(value, { id });
  return new LeakGuard(store);
}

// 以下は leak-guard の実装とは別に、試験の中で書いた変換
const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const allU = (s) => Array.from({ length: s.length }, (_, i) => "\\u" + s.charCodeAt(i).toString(16).padStart(4, "0")).join("");
const allDec = (s) => Array.from(s, (c) => `&#${c.codePointAt(0)};`).join("");
const allHex = (s) => Array.from(s, (c) => `&#x${c.codePointAt(0).toString(16)};`).join("");
const named = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const FORMS = {
  そのまま: S,
  逆順: Array.from(S).reverse().join(""),
  大文字: S.toUpperCase(),
  小文字: S.toLowerCase(),
  URL: encodeURIComponent(S),
  "URL(小文字 %xx)": encodeURIComponent(S).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
  "フォーム(+)": encodeURIComponent(S).replace(/%20/g, "+"),
  "フォーム(URLSearchParams)": new URLSearchParams({ a: S }).toString().slice(2),
  JSON: JSON.stringify(S).slice(1, -1),
  "JSON(全部 \\uXXXX)": allU(S),
  "HTML(名前)": named(S),
  "HTML(&#NN;)": allDec(S),
  "HTML(&#xHH;)": allHex(S),
  base64: Buffer.from(S).toString("base64"),
  "base64(ID:値)": Buffer.from(`${ID}:${S}`).toString("base64"),
  base64url: b64url(Buffer.from(S)),
  "base64url(ID:値)": b64url(Buffer.from(`${ID}:${S}`)),
  "16進(小文字)": hex(S),
  "16進(大文字)": hex(S).toUpperCase(),
};

for (const [name, form] of Object.entries(FORMS)) {
  test(`形を変えた値を見つける: ${name}`, () => {
    const g = makeGuard();
    assert.equal(g.hasLeak(surround(form)), true);
    assert.equal(g.hasLeak({ content: [{ type: "text", text: form }] }), true);
  });
}

test("JSON にした返事の中の値（引用符・バックスラッシュのエスケープ付き）を見つける", () => {
  const g = makeGuard();
  assert.equal(g.hasLeak(JSON.stringify({ text: `x ${S} y` })), true);
});

test("関係ない文字では見つけない", () => {
  const g = makeGuard();
  const noise = [
    'url: http://127.0.0.1:9921/login\ntitle: ログイン\n[1] textbox "ユーザー名" value="(入力済み)"',
    JSON.stringify({ status: "submitted", reason: "", url: "http://127.0.0.1:9921/ok", title: "ok", twoFactor: false }),
    "パスワード", // 値の一部（日本語の所）だけでは見つけない
    "Qx7", // 先頭の一部
    ID, // ID だけ（照合には入れない）
    Buffer.from(ID).toString("base64"),
    "A".repeat(200),
    "",
  ];
  for (const n of noise) assert.equal(g.hasLeak(n), false, `見つけてしまった: ${n.slice(0, 40)}`);
});

test("値が無い時は何も見つけない", () => {
  const g = new LeakGuard(new SecretStore({ ttlMs: 1000 }));
  assert.equal(g.hasLeak(S), false);
});

test("5: 期限は無い。ttlMs を渡しても時間では対象から外れず、入力係が終わるまで探し続ける", async () => {
  const store = new SecretStore({ ttlMs: 30 });
  store.add(S, { id: ID });
  const g = new LeakGuard(store);
  assert.equal(g.hasLeak(S), true);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(g.hasLeak(S), true);
  assert.equal(store.size, 1);
  // 同じ値を足しても増えない
  store.add(S, { id: ID });
  assert.equal(store.size, 1);
});

test("6: 4 文字未満の値は探せない（login はそういうパスワードを入れない）", async () => {
  const { MIN_NEEDLE } = await import("../../src/leak-guard.mjs");
  assert.equal(MIN_NEEDLE, 4);
  const g = makeGuard("abc", "uuuu");
  assert.equal(g.hasLeak("xx abc xx"), false);
  const g4 = makeGuard("abcd", "uuuu");
  assert.equal(g4.hasLeak("xx abcd xx"), true);
});

// base64 は前後に付くバイトでずれるので、前に 0・1・2 バイト付いた形すべてで見つける。
for (const lead of [0, 1, 2]) {
  for (const tail of [0, 1, 2]) {
    test(`base64 のずれ: 前 ${lead} バイト・後ろ ${tail} バイト`, () => {
      const g = makeGuard();
      const pre = "x".repeat(lead);
      const post = "z".repeat(tail);
      const std = Buffer.from(pre + S + post).toString("base64");
      assert.equal(g.hasLeak(`token=${std}`), true, "標準");
      assert.equal(g.hasLeak(`token=${b64url(Buffer.from(pre + S + post))}`), true, "URL 用");
      // ID:値 の形（ID の長さで前のずれが変わる）
      for (const idLen of [5, 6, 7]) {
        const withId = Buffer.from(pre + "j".repeat(idLen) + ":" + S + post).toString("base64");
        assert.equal(g.hasLeak(`Authorization: Basic ${withId}`), true, `ID 付き(ID ${idLen} 字)`);
      }
    });
  }
}

test("base64 のずれ: 乱数のバイトが前後に付いても見つける（前後 0〜2 バイト・180 通り）", () => {
  const g = makeGuard();
  let n = 0;
  for (let lead = 0; lead < 3; lead++) {
    for (let tail = 0; tail < 3; tail++) {
      for (let r = 0; r < 20; r++) {
        const pre = Buffer.from(Array.from({ length: lead }, () => Math.floor(Math.random() * 256)));
        const post = Buffer.from(Array.from({ length: tail }, () => Math.floor(Math.random() * 256)));
        const b = Buffer.concat([pre, Buffer.from(S), post]);
        assert.equal(g.hasLeak(b.toString("base64")), true);
        n++;
      }
    }
  }
  assert.equal(n, 180);
});

test("base64 の関係ないバイト列では見つけない", () => {
  const g = makeGuard();
  for (let i = 0; i < 50; i++) {
    const b = Buffer.from(Array.from({ length: 60 }, () => Math.floor(Math.random() * 256)));
    assert.equal(g.hasLeak(b.toString("base64")), false);
  }
});
