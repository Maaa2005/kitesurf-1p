// 単体試験の道具（試験ファイルではない）。偽のブラウザ・DOM の木・AX の木・偽の設定。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { originPath } from "../../src/browser.mjs";

export const rnd = (n) => Array.from({ length: n }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");

export const ORIGIN = "http://127.0.0.1:9921";

export const tmpDir = (prefix = "ks1p-unit-") => mkdtempSync(path.join(tmpdir(), prefix));

// ---- DOM の木 ----
let nextId = 100;
export function el(name, attrs = {}, children = [], backendNodeId) {
  return {
    nodeType: 1,
    nodeName: name,
    backendNodeId: backendNodeId ?? nextId++,
    attributes: Object.entries(attrs).flat(),
    children,
  };
}

// ログイン画面の DOM。ids: 欄の backendNodeId（変えて「欄が入れ替わった」を作れる）
export function loginDom({ action = "/login", method = "post", pwId = 11, userId = 10, submitId = 12 } = {}) {
  const form = el("FORM", { action, method }, [
    el("INPUT", { type: "text", name: "username" }, [], userId),
    el("INPUT", { type: "password", name: "password" }, [], pwId),
    el("BUTTON", { type: "submit" }, [], submitId),
  ]);
  return {
    nodeType: 9,
    nodeName: "#document",
    backendNodeId: 1,
    baseURL: `${ORIGIN}/login`,
    children: [el("HTML", {}, [el("BODY", {}, [form])])],
  };
}

// ---- AX の木 ----
export function axTree(items) {
  // items: [{role, name, value?, backendDOMNodeId?}]
  const nodes = [{ nodeId: "0", role: { value: "RootWebArea" }, ignored: false, childIds: items.map((_, i) => String(i + 1)) }];
  items.forEach((it, i) => {
    nodes.push({
      nodeId: String(i + 1),
      role: { value: it.role },
      name: { value: it.name ?? "" },
      ...(it.value !== undefined ? { value: { value: it.value } } : {}),
      ignored: false,
      ...(it.backendDOMNodeId !== undefined ? { backendDOMNodeId: it.backendDOMNodeId } : {}),
      childIds: [],
    });
  });
  return nodes;
}

// 高い水準の関数だけの偽のブラウザ。呼ばれた名前を calls に残す。上書きできる。
export function fakeBrowser(over = {}) {
  const calls = [];
  const state = { url: `${ORIGIN}/login`, loaderId: "L1", title: "ログイン", docCalls: 0, protectedSet: new Set() };
  const rec =
    (name, fn) =>
    async (...a) => {
      calls.push(name);
      return fn(...a);
    };
  const b = {
    calls,
    state,
    frame: async () => ({ id: "F", loaderId: state.loaderId, url: state.url }),
    title: async () => state.title,
    info: async () => ({ url: originPath(state.url), title: state.title, rawUrl: state.url }),
    getDocument: async () => {
      state.docCalls++;
      return (state.docFor ?? (() => loginDom()))(state.docCalls);
    },
    axTree: async () => state.ax ?? axTree([]),
    outerHTML: async () => state.html ?? "<html></html>",
    describe: async (id) => (state.describe ? state.describe(id) : { nodeName: "INPUT", attrs: new Map([["type", id === 11 ? "password" : "text"]]) }),
    protectedIds: (loaderId) => new Set(state.protectedSet),
    markProtected: (loaderId, id) => state.protectedSet.add(id),
    valueLength: async (id) => (state.valueLength ? state.valueLength(id) : 0),
    navigate: rec("navigate", async () => {}),
    focus: rec("focus", async () => {}),
    clearField: rec("clearField", async () => {}),
    insertText: rec("insertText", async () => {}),
    fireChange: rec("fireChange", async () => {}),
    clickNode: rec("clickNode", async () => {}),
    pressKey: rec("pressKey", async () => {}),
    waitNavigation: async () => false,
    screenshotPng: rec("screenshotPng", async () => "PNGDATA"),
    withTransparent: async (ids, fn) => (state.withTransparent ? state.withTransparent(ids, fn) : fn()),
    close: async () => {},
  };
  return Object.assign(b, over);
}

export function fakeCfg(over = {}) {
  return {
    kitesurfWs: "ws://127.0.0.1:8787/devtools/browser",
    sites: [{ name: "s", origin: ORIGIN, op: { item: "item-1", vault: "", account: "" }, allowGetForm: false }],
    opCmd: ["fake"],
    logDir: tmpDir("ks1p-log-"),
    approvalTimeoutMs: 1000,
    notify: false,
    allowHttpLoopback: true,
    testMode: false,
    guardDisabled: false,
    ...over,
  };
}

export const LEAK_TEXT = "error: 返事に保護した値が含まれる恐れがあるため返さない";

export const textOf = (res) => res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
