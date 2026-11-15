// 返事の文字の中の、入力係が入れた ID を「(ID)」に置き換える（止めるのではなく置き換える）。
// ID が 4 文字未満の時は何もしない。置き換える形: そのまま・encodeURIComponent・JSON の文字列の中での形・HTML の実体参照の形。
// 大小文字は区別しない。画面写真の中の ID は伏せられない（限界）。

export const ID_MIN_LENGTH = 4;
export const ID_MASK = "(ID)";

const htmlNamed = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const htmlSpecial = (s, f) => s.replace(/[&<>"']/g, (c) => f(c.codePointAt(0)));
const jsonInner = (s) => JSON.stringify(s).slice(1, -1);

export function idForms(id) {
  if (typeof id !== "string" || id.length < ID_MIN_LENGTH) return [];
  const forms = new Set();
  const add = (s) => {
    if (typeof s === "string" && s.length > 0) forms.add(s);
  };
  add(id);
  add(encodeURIComponent(id));
  add(encodeURIComponent(id).replace(/%20/g, "+"));
  const j = jsonInner(id);
  add(j);
  add(j.replace(/\//g, "\\/"));
  add(jsonInner(j)); // JSON の中の JSON
  add(Array.from({ length: id.length }, (_, i) => "\\u" + id.charCodeAt(i).toString(16).padStart(4, "0")).join("")); // 全部 \uXXXX の形
  add(htmlNamed(id));
  add(htmlNamed(id).replace(/&#39;/g, "&apos;"));
  add(htmlNamed(id).replace(/&#39;/g, "&#x27;"));
  add(htmlSpecial(id, (n) => `&#${n};`));
  add(htmlSpecial(id, (n) => `&#x${n.toString(16)};`));
  add(htmlSpecial(id, (n) => `&#x${n.toString(16).toUpperCase()};`));
  return [...forms];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ids: ID の配列。4 文字未満は無視する。
export function maskIds(text, ids) {
  if (typeof text !== "string" || text === "") return text;
  const forms = [...new Set((ids ?? []).flatMap((id) => idForms(id)))];
  if (forms.length === 0) return text;
  forms.sort((a, b) => b.length - a.length); // 長い形から（交互の最初に合う物が使われるため）
  return text.replace(new RegExp(forms.map(escapeRe).join("|"), "gi"), ID_MASK);
}
