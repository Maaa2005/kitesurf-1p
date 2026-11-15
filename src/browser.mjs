// Kitesurf との接続。puppeteer-core でつなぎ、CDP は小さな関数だけ使う（Fetch.enable は使わない）。
import puppeteer from "puppeteer-core";

export class KsError extends Error {
  // message は AI に返してよい文だけにする
  constructor(message) {
    super(message);
    this.name = "KsError";
  }
}

const KEYS = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
};
export const KEY_NAMES = Object.keys(KEYS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// origin + pathname だけにする（? と # の後ろを落とす）。
export function originPath(url) {
  try {
    const u = new URL(url);
    if (u.origin === "null") return `${u.protocol}${u.pathname}`;
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(不明)";
  }
}

export function attrsToMap(attributes) {
  const m = new Map();
  if (!Array.isArray(attributes)) return m;
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    const k = String(attributes[i]).toLowerCase();
    if (!m.has(k)) m.set(k, String(attributes[i + 1]));
  }
  return m;
}

export class KitesurfBrowser {
  #ws;
  #browser = null;
  #page = null;
  #cdp = null;
  #connecting = null;
  #pptr;
  // 入力係が値を入れた欄: loaderId -> Set(backendNodeId)
  #protected = new Map();

  // pptr: puppeteer の代わり（試験用）。
  constructor({ ws, puppeteer: pptr = puppeteer }) {
    this.#ws = ws;
    this.#pptr = pptr;
  }

  async ensure() {
    if (this.#browser && this.#browser.connected && this.#page && !this.#page.isClosed() && this.#cdp) return;
    if (!this.#connecting) {
      this.#connecting = this.#connect().finally(() => {
        this.#connecting = null;
      });
    }
    await this.#connecting;
  }

  async #connect() {
    // 新しいページを作る前に、古いページを閉じる試みをする（失敗・時間切れは無視）。
    const oldPage = this.#page;
    if (oldPage) {
      let t;
      try {
        await Promise.race([Promise.resolve(oldPage.close()), new Promise((r) => (t = setTimeout(r, 3000)))]);
      } catch {
      } finally {
        clearTimeout(t);
      }
    }
    try {
      await this.#browser?.disconnect();
    } catch {}
    this.#browser = this.#page = this.#cdp = null;
    try {
      // logger: 依存の詳細ログ（NODE_DEBUG で CDP の送信内容＝入れる値を stderr に出せる）を全部切る。
      this.#browser = await this.#pptr.connect({ browserWSEndpoint: this.#ws, protocolTimeout: 60000, logger: () => undefined });
      this.#page = await this.#browser.newPage();
      this.#cdp = await this.#page.createCDPSession();
    } catch {
      this.#browser = this.#page = this.#cdp = null;
      throw new KsError("Kitesurf につながらない");
    }
  }

  async close() {
    try {
      await this.#page?.close();
    } catch {}
    try {
      await this.#browser?.disconnect();
    } catch {}
    this.#browser = this.#page = this.#cdp = null;
  }

  async send(method, params = {}) {
    await this.ensure();
    return this.#cdp.send(method, params);
  }

  // ---- 文書の情報 ----

  async frame() {
    const r = await this.send("Page.getFrameTree");
    const f = r.frameTree.frame;
    return { id: f.id, loaderId: f.loaderId, url: f.url };
  }

  async title() {
    try {
      const r = await this.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
      return typeof r.result.value === "string" ? r.result.value : "";
    } catch {
      return "";
    }
  }

  async info() {
    const f = await this.frame();
    return { url: originPath(f.url), title: await this.title(), rawUrl: f.url };
  }

  async readyState() {
    try {
      const r = await this.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      return r.result.value;
    } catch {
      return null;
    }
  }

  async getDocument() {
    const r = await this.send("DOM.getDocument", { depth: -1, pierce: true });
    return r.root;
  }

  async outerHTML() {
    const root = await this.getDocument();
    const r = await this.send("DOM.getOuterHTML", { backendNodeId: root.backendNodeId });
    return r.outerHTML;
  }

  async axTree() {
    try {
      await this.send("Accessibility.enable");
    } catch {}
    const r = await this.send("Accessibility.getFullAXTree");
    return r.nodes || [];
  }

  // 引けなければ null
  async describe(backendNodeId) {
    try {
      const r = await this.send("DOM.describeNode", { backendNodeId });
      const n = r.node;
      return { nodeName: n.nodeName, attrs: attrsToMap(n.attributes) };
    } catch {
      return null;
    }
  }

  async resolveObject(backendNodeId) {
    const r = await this.send("DOM.resolveNode", { backendNodeId });
    return r.object.objectId;
  }

  async callOn(backendNodeId, functionDeclaration, args = []) {
    const objectId = await this.resolveObject(backendNodeId);
    try {
      const r = await this.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new KsError("ページ内の処理に失敗した");
      return r.result?.value;
    } finally {
      this.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  // ---- 入力係が値を入れた欄 ----

  markProtected(loaderId, backendNodeId) {
    for (const k of [...this.#protected.keys()]) if (k !== loaderId) this.#protected.delete(k);
    let s = this.#protected.get(loaderId);
    if (!s) this.#protected.set(loaderId, (s = new Set()));
    s.add(backendNodeId);
  }

  protectedIds(loaderId) {
    return new Set(this.#protected.get(loaderId) ?? []);
  }

  // ---- 操作 ----

  async navigate(url) {
    await this.ensure();
    try {
      await this.#page.goto(url, { waitUntil: "load", timeout: 30000 });
    } catch (e) {
      const m = String(e?.message || "");
      if (/timeout/i.test(m)) throw new KsError("ページの読み込みが時間内に終わらなかった");
      throw new KsError("ページを開けなかった");
    }
  }

  async focus(backendNodeId) {
    await this.send("DOM.focus", { backendNodeId });
  }

  async insertText(text) {
    await this.send("Input.insertText", { text });
  }

  // 欄を空にする（入力係だけの JS）
  async clearField(backendNodeId) {
    await this.callOn(backendNodeId, "function(){ try { this.value = ''; } catch (e) {} }");
  }

  async fireChange(backendNodeId) {
    await this.callOn(backendNodeId, "function(){ this.dispatchEvent(new Event('change', { bubbles: true })); }");
  }

  async valueLength(backendNodeId) {
    return this.callOn(backendNodeId, "function(){ return typeof this.value === 'string' ? this.value.length : 0; }");
  }

  async clickNode(backendNodeId) {
    try {
      await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } catch {}
    let q;
    try {
      q = (await this.send("DOM.getBoxModel", { backendNodeId })).model.content;
    } catch {
      throw new KsError("その部品は画面に出ていないので押せない");
    }
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    const y = (Math.min(...ys) + Math.max(...ys)) / 2;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  async pressKey(name) {
    const k = KEYS[name];
    if (!k) throw new KsError("そのキーは使えない");
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await this.send("Input.dispatchKeyEvent", {
      type: k.text ? "keyDown" : "rawKeyDown",
      ...base,
      ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  // 移動を待つ。始まれば読み込みが終わるまで最大 maxLoadMs。noStartMs たっても始まらなければ、
  // extraMs だけさらに待ってから戻る。戻り値: 移動が始まったか。
  async waitNavigation(fromLoaderId, { noStartMs = 1500, extraMs = 0, maxLoadMs = 15000 } = {}) {
    const t0 = Date.now();
    let started = false;
    while (Date.now() - t0 < noStartMs) {
      const f = await this.frame().catch(() => null);
      if (f && f.loaderId !== fromLoaderId) {
        started = true;
        break;
      }
      await sleep(100);
    }
    if (!started && extraMs > 0) {
      await sleep(extraMs);
      const f = await this.frame().catch(() => null);
      if (f && f.loaderId !== fromLoaderId) started = true;
    }
    if (started) {
      const t1 = Date.now();
      while (Date.now() - t1 < maxLoadMs) {
        if ((await this.readyState()) === "complete") break;
        await sleep(100);
      }
    }
    return started;
  }

  async screenshotPng() {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    return r.data;
  }

  // 撮る間だけ、指定した欄の文字を透明にして fn を行い、必ず元に戻す。
  // 1 つでも透明にできなければ、fn を行わずに KsError を投げる（撮らない）。
  async withTransparent(backendNodeIds, fn) {
    const saved = [];
    const props = ["color", "-webkit-text-fill-color", "caret-color"];
    try {
      for (const id of backendNodeIds) {
        const prev = await this.callOn(
          id,
          `function(p){ const out = p.map(n => [this.style.getPropertyValue(n), this.style.getPropertyPriority(n)]);
             for (const n of p) this.style.setProperty(n, 'transparent', 'important'); return out; }`,
          [props],
        ).catch(() => null);
        if (!Array.isArray(prev)) throw new KsError("パスワード欄の文字を透明にできなかったので撮らない");
        saved.push([id, prev]);
      }
      return await fn();
    } finally {
      for (const [id, prev] of saved) {
        await this.callOn(
          id,
          `function(p, prev){ p.forEach((n, i) => { if (prev[i][0]) this.style.setProperty(n, prev[i][0], prev[i][1]); else this.style.removeProperty(n); }); }`,
          [props, prev],
        ).catch(() => {});
      }
    }
  }
}
