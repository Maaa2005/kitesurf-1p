// アクセシビリティの木から、値を消した一覧を作る。
import { originPath, attrsToMap, KsError } from "./browser.mjs";

const INTERACTIVE = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "button",
  "link",
  "checkbox",
  "radio",
  "menuitem",
  "tab",
  "option",
  "switch",
  "slider",
  "spinbutton",
]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "slider", "spinbutton"]);
const MAX_TOTAL = 20000;
const MAX_FIELD = 200;

const clip = (s, n = MAX_FIELD) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ref の番号 -> {backendNodeId, loaderId}。最後の snapshot の分だけ持つ。
export class RefTable {
  #refs = new Map();

  replace(map) {
    this.#refs = map;
  }

  resolve(ref, currentLoaderId) {
    const r = this.#refs.get(ref);
    if (!r || r.loaderId !== currentLoaderId) throw new KsError("ref が古い。snapshot を取り直す");
    return r;
  }
}

// 今の文書の DOM（pierce）を歩いて、type=password の input の backendNodeId を集める。
export function findPasswordIds(root) {
  const ids = [];
  const walk = (n) => {
    if (!n) return;
    if (n.nodeName === "INPUT") {
      const t = (attrsToMap(n.attributes).get("type") ?? "").trim().toLowerCase();
      if (t === "password") ids.push(n.backendNodeId);
    }
    for (const c of n.children ?? []) walk(c);
    for (const c of n.shadowRoots ?? []) walk(c);
    if (n.contentDocument) walk(n.contentDocument);
  };
  walk(root);
  return ids;
}

// 戻り値: {text, refs: Map}
// mask: 文字の中の ID を (ID) にする関数。切る前の元の文字に掛ける（切れ目が ID の途中にあっても残りが出ないように）。
export async function buildSnapshot(browser, { hide = true, mask = (s) => s } = {}) {
  const frame = await browser.frame();
  const nodes = await browser.axTree();
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));

  // 値を出さない欄: 今 type=password の input と、入力係が値を入れた欄
  const hidden = new Set();
  if (hide) {
    const root = await browser.getDocument();
    for (const id of findPasswordIds(root)) hidden.add(id);
    for (const id of browser.protectedIds(frame.loaderId)) hidden.add(id);
    // DOM の木に出てこない欄（種類を後から変えた物など）も、値を持つ節は 1 つずつ DOM.describeNode で確かめる
    await Promise.all(
      nodes
        .filter((n) => n.value && typeof n.value.value === "string" && n.backendDOMNodeId !== undefined && n.role?.value !== "RootWebArea")
        .map(async (n) => {
          const d = await browser.describe(n.backendDOMNodeId);
          if (d && d.nodeName === "INPUT" && (d.attrs.get("type") ?? "").trim().toLowerCase() === "password") hidden.add(n.backendDOMNodeId);
          if (!d) hidden.add(n.backendDOMNodeId); // 引けない節は安全側に倒す
        }),
    );
  }

  const lines = [];
  // 切る前の元の文字（欄・文）。返事は切った後の文字だけを返すが、切れ目にまたがる値を見逃さないため、元の文字も照合に回す。
  const rawPieces = [];
  const rawLines = [];
  const refs = new Map();
  let next = 1;
  let lastText = null;

  const propOf = (n, name) => {
    const p = (n.properties ?? []).find((x) => x.name === name);
    return p ? p.value?.value : undefined;
  };

  const visit = (n, depth) => {
    if (!n || depth > 200) return;
    const role = n.role?.value;
    const rawName = typeof n.name?.value === "string" ? n.name.value : "";
    const name = mask(rawName);
    if (!n.ignored && role && INTERACTIVE.has(role) && n.backendDOMNodeId !== undefined) {
      const ref = next++;
      refs.set(ref, { backendNodeId: n.backendDOMNodeId, loaderId: frame.loaderId });
      let line = `[${ref}] ${role} ${JSON.stringify(clip(name))}`;
      let rawLine = `[${ref}] ${role} ${JSON.stringify(rawName)}`;
      rawPieces.push(rawName);
      if (VALUE_ROLES.has(role)) {
        const raw = typeof n.value?.value === "string" ? n.value.value : "";
        if (hidden.has(n.backendDOMNodeId)) {
          line += ` value=${JSON.stringify(raw.length ? "(入力済み)" : "(空)")}`;
          rawLine += ` value=${JSON.stringify(raw.length ? "(入力済み)" : "(空)")}`;
        } else if (raw.length) {
          line += ` value=${JSON.stringify(clip(mask(raw)))}`;
          rawLine += ` value=${JSON.stringify(raw)}`;
          rawPieces.push(raw);
        } else if (!hide) {
          line += ` value=""`;
          rawLine += ` value=""`;
        }
      }
      const checked = propOf(n, "checked");
      if (checked === true || checked === "true") line += " checked";
      if (propOf(n, "disabled") === true) line += " disabled";
      lines.push(line);
      rawLines.push(rawLine);
      lastText = null;
      return; // 中の文字は部品の名前に入っているので出さない
    }
    if (!n.ignored && role === "StaticText" && rawName.trim()) {
      const fullRaw = rawName.trim();
      const t = clip(name.trim(), 500);
      if (t !== lastText) {
        lines.push(`text: ${t}`);
        rawLines.push(`text: ${fullRaw}`);
        rawPieces.push(fullRaw);
      }
      lastText = t;
    }
    for (const cid of n.childIds ?? []) visit(byId.get(cid), depth + 1);
  };
  if (nodes.length) visit(nodes[0], 0);

  const title = await browser.title();
  let text = `url: ${mask(originPath(frame.url))}\ntitle: ${mask(title)}\n${lines.join("\n")}`;
  // 全体を切る前の元の文字（欄・文を切る前の物をつなげた全体）
  const rawWhole = `url: ${originPath(frame.url)}\ntitle: ${title}\n${rawLines.join("\n")}`;
  if (text.length > MAX_TOTAL) text = `${text.slice(0, MAX_TOTAL)}\n…(省略)`;
  // raw: 切る前の元の文字。返さずに照合だけに使う（住所は ? と # の後ろを落とす前の物）。
  return { text, refs, loaderId: frame.loaderId, raw: [frame.url, title, ...rawPieces, rawWhole] };
}

// 画面写真の前の探し物: 今の画面の文字（アクセシビリティの木の JSON と DOM 全体）
export async function collectScreenTexts(browser) {
  const [nodes, html] = await Promise.all([browser.axTree(), browser.outerHTML()]);
  return [JSON.stringify(nodes), html];
}
