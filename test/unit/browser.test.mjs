// browser.mjs: 1a（logger を切る）・12（透明にできなければ撮らない）・14（再接続で古いページを閉じる）
import { test } from "node:test";
import assert from "node:assert/strict";
import { KitesurfBrowser, KsError } from "../../src/browser.mjs";

// 偽の puppeteer。connect の引数と、呼ばれた順を残す。
function fakePuppeteer() {
  const events = [];
  const connects = [];
  let n = 0;
  const pptr = {
    events,
    connects,
    pages: [],
    connect: async (opts) => {
      connects.push(opts);
      const id = ++n;
      events.push(`connect#${id}`);
      const browser = {
        connected: true,
        disconnect: async () => {
          events.push(`disconnect#${id}`);
          browser.connected = false;
        },
        newPage: async () => {
          events.push(`newPage#${id}`);
          const page = {
            id,
            closed: false,
            isClosed: () => page.closed,
            close: async () => {
              events.push(`close-page#${id}`);
              if (pptr.closeThrows) throw new Error("boom");
              page.closed = true;
            },
            createCDPSession: async () => ({ send: async () => ({}) }),
          };
          pptr.pages.push(page);
          return page;
        },
      };
      pptr.lastBrowser = browser;
      return browser;
    },
  };
  return pptr;
}

test("1a: puppeteer.connect に logger（全部の記録を切る関数）を渡す", async () => {
  const p = fakePuppeteer();
  const b = new KitesurfBrowser({ ws: "ws://127.0.0.1:8787/devtools/browser", puppeteer: p });
  await b.ensure();
  assert.equal(p.connects.length, 1);
  const { logger } = p.connects[0];
  assert.equal(typeof logger, "function");
  // Puppeteer は logger(prefix) が関数を返せば記録を出す。どの記録の名前でも undefined を返す（出さない）。
  for (const prefix of ["puppeteer:protocol:SEND ►", "puppeteer:protocol:RECV ◀", "puppeteer:error", "puppeteer:webDriverBiDi:SEND ►", "x"]) {
    assert.equal(logger(prefix), undefined, prefix);
  }
  assert.equal(p.connects[0].browserWSEndpoint, "ws://127.0.0.1:8787/devtools/browser");
});

test("14: 再接続の時、新しいページを作る前に古いページを閉じる試みをする", async () => {
  const p = fakePuppeteer();
  const b = new KitesurfBrowser({ ws: "ws://127.0.0.1:8787/x", puppeteer: p });
  await b.ensure();
  p.lastBrowser.connected = false; // 接続が切れた
  p.events.length = 0;
  await b.ensure();
  const i = (e) => p.events.indexOf(e);
  assert.ok(i("close-page#1") >= 0, "古いページを閉じようとした");
  assert.ok(i("newPage#2") >= 0);
  assert.ok(i("close-page#1") < i("newPage#2"), `順序: ${p.events.join(",")}`);
});

test("14: 古いページを閉じるのに失敗しても無視して、新しいページを作る", async () => {
  const p = fakePuppeteer();
  const b = new KitesurfBrowser({ ws: "ws://127.0.0.1:8787/x", puppeteer: p });
  await b.ensure();
  p.closeThrows = true;
  p.lastBrowser.connected = false;
  p.events.length = 0;
  await b.ensure();
  assert.ok(p.events.includes("close-page#1"));
  assert.ok(p.events.includes("newPage#2"));
  assert.equal(p.pages.length, 2);
});

test("14: 古いページが閉じるのを返さなくても、時間切れで先へ進む", async () => {
  const p = fakePuppeteer();
  const b = new KitesurfBrowser({ ws: "ws://127.0.0.1:8787/x", puppeteer: p });
  await b.ensure();
  p.pages[0].close = async () => {
    p.events.push("close-page#1");
    await new Promise(() => {}); // 返さない
  };
  p.lastBrowser.connected = false;
  const t0 = Date.now();
  await b.ensure();
  assert.ok(Date.now() - t0 < 10000);
  assert.ok(p.events.includes("newPage#2"));
});

// ---- 12. withTransparent ----
// send を差し替えて、CDP の返事を台本どおりにする
class ScriptedBrowser extends KitesurfBrowser {
  constructor(script) {
    super({ ws: "ws://127.0.0.1:1/x", puppeteer: {} });
    this.script = script;
    this.sent = [];
  }
  async send(method, params = {}) {
    this.sent.push({ method, params });
    return this.script(method, params);
  }
}

test("12: 透明にする処理が失敗したら fn（撮る処理）を行わずに KsError。すでに透明にした欄は元に戻す", async () => {
  const b = new ScriptedBrowser((method, params) => {
    if (method === "DOM.resolveNode") return { object: { objectId: `obj-${params.backendNodeId}` } };
    if (method === "Runtime.callFunctionOn") {
      if (params.objectId === "obj-2" && params.functionDeclaration.includes("transparent")) return { exceptionDetails: { text: "x" } };
      if (params.functionDeclaration.includes("transparent")) return { result: { value: [["", ""], ["", ""], ["", ""]] } };
      return { result: {} };
    }
    return {};
  });
  let shot = false;
  await assert.rejects(
    b.withTransparent([1, 2], async () => {
      shot = true;
      return "data";
    }),
    (e) => e instanceof KsError && /撮らない/.test(e.message),
  );
  assert.equal(shot, false, "撮っていない");
  // 欄 1 は元に戻す呼び出しが行われた（transparent を含まない呼び出し）
  const restores = b.sent.filter((x) => x.method === "Runtime.callFunctionOn" && x.params.objectId === "obj-1" && !x.params.functionDeclaration.includes("'transparent'"));
  assert.equal(restores.length, 1);
});

test("12: 透明にできれば fn を行い、結果を返して元に戻す", async () => {
  const b = new ScriptedBrowser((method, params) => {
    if (method === "DOM.resolveNode") return { object: { objectId: `obj-${params.backendNodeId}` } };
    if (method === "Runtime.callFunctionOn") return { result: { value: [["", ""], ["", ""], ["", ""]] } };
    return {};
  });
  const r = await b.withTransparent([5], async () => "data");
  assert.equal(r, "data");
  const calls = b.sent.filter((x) => x.method === "Runtime.callFunctionOn");
  assert.equal(calls.length, 2, "透明にする・元に戻す");
});

test("12: 結果が配列でない（透明にできたか分からない）時も撮らない", async () => {
  const b = new ScriptedBrowser((method, params) => {
    if (method === "DOM.resolveNode") return { object: { objectId: "o" } };
    if (method === "Runtime.callFunctionOn") return { result: {} };
    return {};
  });
  let shot = false;
  await assert.rejects(b.withTransparent([5], async () => ((shot = true), "d")), KsError);
  assert.equal(shot, false);
});

test("12: 欄が 0 個なら、そのまま撮る", async () => {
  const b = new ScriptedBrowser(() => ({}));
  assert.equal(await b.withTransparent([], async () => "d"), "d");
});
