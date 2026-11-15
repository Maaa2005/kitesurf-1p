// createGateway（server.mjs）と login.mjs を、偽のブラウザ・偽の provider で試す。
// 6（短いパスワード）・7（切る前の確かめ）・8（ID の伏せ字）・11（送る直前の確かめ）・12（画面写真）・5（期限なし）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../../src/server.mjs";
import { SecretStore } from "../../src/secret-store.mjs";
import { rnd, fakeBrowser, fakeCfg, loginDom, axTree, ORIGIN, LEAK_TEXT, textOf } from "./_helpers.mjs";

const mkPass = () => `${rnd(8)}!#パス${rnd(6)}`;
const mkUser = () => `user-${rnd(8)}`;

function gateway({ browser = fakeBrowser(), cfg = fakeCfg(), creds } = {}) {
  const calls = [];
  const provider = async (args) => {
    calls.push(args);
    return creds ?? { status: "ok", username: "u", password: "p", urls: [ORIGIN] };
  };
  const gw = createGateway(cfg, { browser, provider, notify: async () => "skipped" });
  return { gw, browser, providerCalls: calls };
}

const parse = (res) => JSON.parse(textOf(res));

// ---- 6. 短いパスワード ----
for (const pw of ["", "a", "abc"]) {
  test(`6: 4 文字未満のパスワード（${pw.length} 字）は入れずに error・理由つき・値を捨てる`, async () => {
    const user = mkUser();
    const { gw, browser } = gateway({ creds: { status: "ok", username: user, password: pw, urls: [ORIGIN] } });
    const res = await gw.call("login", { site: "s", reason: "x" });
    const j = parse(res);
    assert.equal(j.status, "error");
    assert.equal(j.reason, "パスワードが短くて見張れないので入れない");
    assert.ok(!browser.calls.includes("insertText"), "入れていない");
    assert.ok(!browser.calls.includes("clickNode"), "送っていない");
    assert.equal(gw.store.size, 0, "照合用にも入れない");
    assert.deepEqual(gw.store.ids(), []);
  });
}

test("6: ちょうど 4 文字なら入れる", async () => {
  const { gw, browser } = gateway({ creds: { status: "ok", username: "uuuu", password: "abcd", urls: [ORIGIN] } });
  const j = parse(await gw.call("login", { site: "s", reason: "x" }));
  assert.equal(j.status, "submitted");
  assert.ok(browser.calls.includes("insertText"));
});

// ---- 11. 送る直前の確かめ ----
test("11: 3 回目の調べ直し（送る直前）で送り先が別の origin になっていたら changed。送らない", async () => {
  const browser = fakeBrowser();
  // getDocument の 1 回目: 最初の調べ・2 回目: 承認の後・3 回目: 送る直前
  browser.state.docFor = (n) => (n >= 3 ? loginDom({ action: "http://127.0.0.1:9922/steal" }) : loginDom());
  const { gw } = gateway({ browser, creds: { status: "ok", username: "uuuu", password: mkPass(), urls: [ORIGIN] } });
  const j = parse(await gw.call("login", { site: "s", reason: "x" }));
  assert.equal(j.status, "changed");
  assert.ok(browser.calls.includes("insertText"), "入れる所までは進んだ");
  assert.ok(!browser.calls.includes("clickNode"), "送っていない");
  assert.ok(!browser.calls.includes("pressKey"), "Enter も送っていない");
});

test("11: 送る直前に送信ボタンの欄が入れ替わっていたら changed。送らない", async () => {
  const browser = fakeBrowser();
  browser.state.docFor = (n) => (n >= 3 ? loginDom({ submitId: 99 }) : loginDom());
  const { gw } = gateway({ browser, creds: { status: "ok", username: "uuuu", password: mkPass(), urls: [ORIGIN] } });
  const j = parse(await gw.call("login", { site: "s", reason: "x" }));
  assert.equal(j.status, "changed");
  assert.ok(!browser.calls.includes("clickNode"));
});

test("11: 送る直前にパスワード欄が type=text に変わっていたら changed。送らない", async () => {
  const browser = fakeBrowser();
  let describeCalls = 0;
  browser.state.describe = (id) => {
    describeCalls++;
    // 承認の後の 1 回目は password・送る直前の 2 回目は text
    return { nodeName: "INPUT", attrs: new Map([["type", id === 11 && describeCalls < 2 ? "password" : "text"]]) };
  };
  const { gw } = gateway({ browser, creds: { status: "ok", username: "uuuu", password: mkPass(), urls: [ORIGIN] } });
  const j = parse(await gw.call("login", { site: "s", reason: "x" }));
  assert.equal(j.status, "changed");
  assert.ok(!browser.calls.includes("clickNode"));
});

test("11: 何も変わらなければ送る（対照）", async () => {
  const browser = fakeBrowser();
  const { gw } = gateway({ browser, creds: { status: "ok", username: "uuuu", password: mkPass(), urls: [ORIGIN] } });
  const j = parse(await gw.call("login", { site: "s", reason: "x" }));
  assert.equal(j.status, "submitted");
  assert.ok(browser.calls.includes("clickNode"));
});

// ---- 7. 切る前の確かめ ----
test("7: 文の 500 字の切れ目にまたがる値は、切った後の文に無くても返事ごと止める", async () => {
  const pass = mkPass();
  const browser = fakeBrowser();
  const long = "x".repeat(497) + pass; // 500 字で切ると値の先頭 3 字しか残らない
  browser.state.ax = axTree([{ role: "StaticText", name: long }]);
  const { gw } = gateway({ browser });
  gw.store.add(pass, { id: "" });
  const res = await gw.call("snapshot");
  assert.equal(res.isError, true);
  assert.equal(textOf(res), LEAK_TEXT);
});

test("7: 欄の名前の 200 字の切れ目にまたがる値も止める", async () => {
  const pass = mkPass();
  const browser = fakeBrowser();
  browser.state.ax = axTree([{ role: "button", name: "y".repeat(197) + pass, backendDOMNodeId: 50 }]);
  const { gw } = gateway({ browser });
  gw.store.add(pass, { id: "" });
  const res = await gw.call("snapshot");
  assert.equal(res.isError, true);
  assert.equal(textOf(res), LEAK_TEXT);
});

test("7: 欄の値の 200 字の切れ目にまたがる値も止める", async () => {
  const pass = mkPass();
  const browser = fakeBrowser();
  browser.state.ax = axTree([{ role: "textbox", name: "メモ", value: "z".repeat(198) + pass, backendDOMNodeId: 51 }]);
  const { gw } = gateway({ browser });
  gw.store.add(pass, { id: "" });
  const res = await gw.call("snapshot");
  assert.equal(res.isError, true);
});

test("7: 全体の 20000 字の切れ目より後ろにある値も止める", async () => {
  const pass = mkPass();
  const browser = fakeBrowser();
  const items = [];
  for (let i = 0; i < 50; i++) items.push({ role: "StaticText", name: `行${i}-${"q".repeat(440)}` });
  items.push({ role: "StaticText", name: `最後の行 ${pass}` });
  browser.state.ax = axTree(items);
  const { gw } = gateway({ browser });
  gw.store.add(pass, { id: "" });
  const res = await gw.call("snapshot");
  assert.equal(res.isError, true);
  assert.equal(textOf(res), LEAK_TEXT);
});

test("7: 対照: 値が無ければ同じ画面は普通に返る（切った印も付く）", async () => {
  const browser = fakeBrowser();
  const items = [];
  for (let i = 0; i < 50; i++) items.push({ role: "StaticText", name: `行${i}-${"q".repeat(440)}` });
  browser.state.ax = axTree(items);
  const { gw } = gateway({ browser });
  gw.store.add(mkPass(), { id: "" });
  const res = await gw.call("snapshot");
  assert.notEqual(res.isError, true);
  assert.match(textOf(res), /…\(省略\)/);
});

test("7: 住所の ? の後ろ（切る前の元の住所）にまたがった値も止める（open）", async () => {
  const pass = mkPass();
  const browser = fakeBrowser();
  browser.state.url = `${ORIGIN}/a?x=${pass}`;
  const { gw } = gateway({ browser });
  gw.store.add(pass, { id: "" });
  const res = await gw.call("open", { url: "about:blank" });
  assert.equal(res.isError, true);
  assert.equal(textOf(res), LEAK_TEXT);
});

test("7: 題名の中の値は今までどおり止める", async () => {
  const pass = mkPass();
  const browser = fakeBrowser();
  browser.state.title = `ようこそ ${pass}`;
  const { gw } = gateway({ browser });
  gw.store.add(pass, { id: "" });
  const res = await gw.call("open", { url: "about:blank" });
  assert.equal(res.isError, true);
});

// ---- 8. ID の伏せ字 ----
test("8: 返事の中の ID を (ID) に置き換える（止めない）。形: そのまま・URL・JSON・HTML", async () => {
  const pass = mkPass();
  const id = `us"er&<${rnd(4)}>/x y`;
  const browser = fakeBrowser();
  browser.state.ax = axTree([
    { role: "StaticText", name: `こんにちは ${id}` },
    { role: "StaticText", name: `url: ${encodeURIComponent(id)}` },
    { role: "StaticText", name: `html: ${id.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}` },
    { role: "StaticText", name: `json: ${JSON.stringify(id).slice(1, -1)}` },
    { role: "StaticText", name: "関係ない文" },
  ]);
  const { gw } = gateway({ browser });
  gw.store.add(pass, { id });
  const res = await gw.call("snapshot");
  assert.notEqual(res.isError, true);
  const t = textOf(res);
  assert.match(t, /text: こんにちは \(ID\)/);
  assert.match(t, /text: url: \(ID\)/);
  assert.match(t, /text: html: \(ID\)/);
  assert.match(t, /text: json: \(ID\)/);
  assert.match(t, /関係ない文/);
  assert.ok(!t.includes(id));
  assert.ok(!t.includes(encodeURIComponent(id)));
  assert.ok(!t.includes(JSON.stringify(id).slice(1, -1)));
});

test("8: 題名・login の返事（JSON の中）の ID も伏せる", async () => {
  const user = mkUser();
  const browser = fakeBrowser();
  browser.state.title = `${user} のページ`;
  const { gw } = gateway({ browser, creds: { status: "ok", username: user, password: mkPass(), urls: [ORIGIN] } });
  const res = await gw.call("login", { site: "s", reason: "x" });
  const t = textOf(res);
  assert.ok(!t.includes(user), "返事に ID が残っている");
  assert.equal(parse(res).status, "submitted");
  assert.match(parse(res).title, /^\(ID\) のページ$/);
  const o = await gw.call("open", { url: "about:blank" });
  assert.ok(!textOf(o).includes(user));
  assert.match(textOf(o), /title: \(ID\) のページ/);
});

test("8: 4 文字未満の ID は置き換えない", async () => {
  const browser = fakeBrowser();
  browser.state.ax = axTree([{ role: "StaticText", name: "こんにちは abc さん" }]);
  const { gw } = gateway({ browser });
  gw.store.add(mkPass(), { id: "abc" });
  const t = textOf(await gw.call("snapshot"));
  assert.match(t, /abc さん/);
});

test("8: 大文字小文字が違っても伏せる", async () => {
  const browser = fakeBrowser();
  browser.state.ax = axTree([{ role: "StaticText", name: "ようこそ USER-ABCD1234" }]);
  const { gw } = gateway({ browser });
  gw.store.add(mkPass(), { id: "user-abcd1234" });
  const t = textOf(await gw.call("snapshot"));
  assert.match(t, /ようこそ \(ID\)/);
});

test("8: 隠す処理を切った対照（guardDisabled）では伏せない", async () => {
  const user = mkUser();
  const browser = fakeBrowser();
  browser.state.ax = axTree([{ role: "StaticText", name: `ようこそ ${user}` }]);
  const { gw } = gateway({ browser, cfg: fakeCfg({ guardDisabled: true }) });
  gw.store.add(mkPass(), { id: user });
  assert.ok(textOf(await gw.call("snapshot")).includes(user));
});

test("8: ID は入力係が終わるまで持つ（SecretStore に期限は無い）", async () => {
  const store = new SecretStore({ ttlMs: 5, now: () => Date.now() + 1e12 });
  store.add("パスワード12345", { id: "user-abcd" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.size, 1);
  assert.deepEqual(store.ids(), ["user-abcd"]);
  assert.equal(store.entries()[0].value, "パスワード12345");
});

// ---- 12. 画面写真 ----
test("12: 透明にする処理が失敗したら、撮らずに誤りを返す", async () => {
  const browser = fakeBrowser();
  browser.state.withTransparent = async () => {
    const { KsError } = await import("../../src/browser.mjs");
    throw new KsError("パスワード欄の文字を透明にできなかったので撮らない");
  };
  const { gw } = gateway({ browser });
  const res = await gw.call("screenshot");
  assert.equal(res.isError, true);
  assert.ok(!res.content.some((c) => c.type === "image"));
  assert.ok(!browser.calls.includes("screenshotPng"));
});

test("12: 撮った後の確かめで欄に値が残っていたら、画像を捨てて誤りを返す", async () => {
  const browser = fakeBrowser();
  browser.state.protectedSet = new Set([10, 11]);
  let n = 0;
  browser.state.valueLength = (id) => {
    n++;
    return n <= 2 ? 0 : 5; // 撮る前（2 欄）は空・撮った後は値がある
  };
  const { gw } = gateway({ browser });
  const res = await gw.call("screenshot");
  assert.equal(res.isError, true);
  assert.ok(!res.content.some((c) => c.type === "image"));
  assert.ok(browser.calls.includes("screenshotPng"), "撮ってはいた");
});

test("12: 撮った後の確かめで画面の文字に値があれば、画像を捨てて誤りを返す", async () => {
  const pass = mkPass();
  const browser = fakeBrowser();
  const { gw } = gateway({ browser });
  gw.store.add(pass, { id: "" });
  browser.screenshotPng = async () => {
    browser.calls.push("screenshotPng");
    browser.state.html = `<p>${pass}</p>`; // 撮っている間に値が画面に出た
    return "PNGDATA";
  };
  const res = await gw.call("screenshot");
  assert.equal(res.isError, true);
  assert.ok(!res.content.some((c) => c.type === "image"));
});

test("12: 撮っている間に文書が変わったら画像を捨てる", async () => {
  const browser = fakeBrowser();
  browser.screenshotPng = async () => {
    browser.calls.push("screenshotPng");
    browser.state.loaderId = "L2";
    return "PNGDATA";
  };
  const { gw } = gateway({ browser });
  const res = await gw.call("screenshot");
  assert.equal(res.isError, true);
  assert.ok(!res.content.some((c) => c.type === "image"));
});

test("12: 対照: 何も問題が無ければ画像を返す", async () => {
  const { gw } = gateway();
  const res = await gw.call("screenshot");
  assert.notEqual(res.isError, true);
  assert.ok(res.content.some((c) => c.type === "image"));
});

// ---- 8 の直し: 切る前に置き換える・返事の形を壊さない ----
test("8: 切れ目が ID の途中にあっても、残りの部分は出ない（文 500 字・欄の名前 200 字・欄の値 200 字）", async () => {
  const id = `user-${rnd(8)}`; // 13 字
  for (const cut of [1, 5, 12]) {
    const browser = fakeBrowser();
    browser.state.ax = axTree([
      { role: "StaticText", name: "x".repeat(500 - cut) + id }, // 500 字目が ID の途中
      { role: "button", name: "y".repeat(200 - cut) + id, backendDOMNodeId: 50 },
      { role: "textbox", name: "メモ", value: "z".repeat(200 - cut) + id, backendDOMNodeId: 51 },
    ]);
    const { gw } = gateway({ browser });
    gw.store.add(mkPass(), { id });
    const res = await gw.call("snapshot");
    assert.notEqual(res.isError, true);
    const t = textOf(res);
    // ID の 3 字以上の部分が 1 つも残らない（置き換えの後で切ると、切れ目の前の部分が残る）
    for (let n = 3; n <= id.length; n++) {
      for (let i = 0; i + n <= id.length; i++) assert.ok(!t.includes(id.slice(i, i + n)), `ID の一部「${id.slice(i, i + n)}」が残った: 切れ目 ${cut}`);
    }
  }
});

test("8: 対照: 置き換えを切った後にしていたら、切れ目の前の ID の一部が残る（試験の感度）", () => {
  const id = "user-ABCDEFGH";
  const clipped = ("x".repeat(497) + id).slice(0, 500);
  assert.ok(clipped.endsWith("use")); // 切った後には ID の先頭 3 字が残る
});

test("8: ID が status・true・title・twoFactor・submitted と同じでも、login の返事の形は壊れない", async () => {
  for (const id of ["status", "true", "false", "title", "reason", "twoFactor", "submitted", "(ID)"]) {
    const browser = fakeBrowser();
    browser.state.title = `${id} ページ`;
    const { gw } = gateway({ browser, creds: { status: "ok", username: id, password: mkPass(), urls: [ORIGIN] } });
    const res = await gw.call("login", { site: "s", reason: "x" });
    const j = parse(res); // JSON のまま読める
    assert.deepEqual(Object.keys(j).sort(), ["reason", "status", "title", "twoFactor", "url"], id);
    assert.equal(j.status, "submitted", id);
    assert.equal(j.twoFactor, false, id);
    assert.equal(j.reason, "", id);
    assert.equal(j.title, "(ID) ページ", id);
    assert.equal(j.url, `${ORIGIN}/login`, id);
  }
});

test("8: ID が url の中の語と同じでも、url の値の中だけ置き換わる", async () => {
  const browser = fakeBrowser();
  browser.state.url = `${ORIGIN}/login`;
  const { gw } = gateway({ browser, creds: { status: "ok", username: "login", password: mkPass(), urls: [ORIGIN] } });
  const j = parse(await gw.call("login", { site: "s", reason: "x" }));
  assert.equal(j.url, `${ORIGIN}/(ID)`);
  assert.equal(j.status, "submitted");
});

test("8: ID が textbox・button・title・url・text と同じでも、snapshot・open の形（行の頭・役割）は壊れない", async () => {
  for (const id of ["textbox", "button", "title", "text", "value"]) {
    const browser = fakeBrowser();
    browser.state.title = `${id} ページ`;
    browser.state.ax = axTree([
      { role: "textbox", name: "名前", value: "入力", backendDOMNodeId: 50 },
      { role: "button", name: `押す ${id}`, backendDOMNodeId: 51 },
      { role: "StaticText", name: `本文 ${id}` },
    ]);
    const { gw } = gateway({ browser });
    gw.store.add(mkPass(), { id });
    const t = textOf(await gw.call("snapshot"));
    const lines = t.split("\n");
    assert.equal(lines[0], `url: ${ORIGIN}/login`, id);
    assert.equal(lines[1], "title: (ID) ページ", id);
    assert.equal(lines[2], '[1] textbox "名前" value="入力"', id);
    assert.equal(lines[3], '[2] button "押す (ID)"', id);
    assert.equal(lines[4], "text: 本文 (ID)", id);
    const o = textOf(await gw.call("open", { url: "about:blank" }));
    assert.equal(o, `url: ${ORIGIN}/login\ntitle: (ID) ページ`, id);
  }
});
