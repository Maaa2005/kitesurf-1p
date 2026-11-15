// id-mask.mjs: 返事の中の ID を (ID) に置き換える（8）
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskIds, idForms } from "../../src/id-mask.mjs";

const ID = "us\"er&<a1B2>'/x y@例";

const FORMS = {
  そのまま: ID,
  encodeURIComponent: encodeURIComponent(ID),
  "フォーム(+)": encodeURIComponent(ID).replace(/%20/g, "+"),
  "JSON の文字列の中": JSON.stringify(ID).slice(1, -1),
  "JSON の中の JSON": JSON.stringify(JSON.stringify(ID).slice(1, -1)).slice(1, -1),
  "HTML(名前)": ID.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
  "HTML(&apos;)": ID.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"),
  "HTML(&#NN;)": ID.replace(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`),
  "HTML(&#xHH;)": ID.replace(/[&<>"']/g, (c) => `&#x${c.codePointAt(0).toString(16)};`),
};

for (const [name, form] of Object.entries(FORMS)) {
  test(`置き換える: ${name}`, () => {
    const out = maskIds(`前 ${form} 後`, [ID]);
    assert.equal(out, "前 (ID) 後");
  });
}

test("1 つの文に複数・違う形が混ざっても全部置き換える", () => {
  const t = `${ID} / ${FORMS.encodeURIComponent} / ${FORMS["HTML(名前)"]}`;
  assert.equal(maskIds(t, [ID]), "(ID) / (ID) / (ID)");
});

test("大文字小文字を区別しない", () => {
  assert.equal(maskIds("USER-ABCD", ["user-abcd"]), "(ID)");
});

test("4 文字未満の ID・空・無い時は何もしない", () => {
  assert.equal(maskIds("abc abc", ["abc"]), "abc abc");
  assert.equal(maskIds("abc", ["", "ab"]), "abc");
  assert.equal(maskIds("abc", []), "abc");
  assert.equal(maskIds("abc", undefined), "abc");
  assert.deepEqual(idForms("abc"), []);
});

test("4 文字ちょうどは置き換える", () => {
  assert.equal(maskIds("x abcd y", ["abcd"]), "x (ID) y");
});

test("ID に正規表現の記号があっても、そのままの文字として探す", () => {
  assert.equal(maskIds("a.b*c+d and axbbbcd", ["a.b*c+d"]), "(ID) and axbbbcd");
});

test("複数の ID・片方が片方を含んでも長い方を先に置き換える", () => {
  assert.equal(maskIds("user-abcd-long と user-abcd", ["user-abcd", "user-abcd-long"]), "(ID) と (ID)");
});

test("関係ない文は変えない", () => {
  const t = "url: http://127.0.0.1:9921/login\ntitle: ログイン";
  assert.equal(maskIds(t, ["user-abcd1234"]), t);
});
