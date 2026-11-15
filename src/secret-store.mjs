// 値を照合用にだけメモリに持つ。期限は無い（入力係が終わるまで持つ）。外には値を返さない道は leak-guard と id-mask だけ。
// 時間で照合の対象から外すと、ページに値が残ったまま守りが切れるため。
export class SecretStore {
  #entries = [];
  #ids = new Set();

  // 引数は受け取るが使わない（昔の ttlMs・now を渡す呼び出しを壊さないため）。
  constructor(_options = {}) {}

  // value: 照合するパスワード。id: base64 の `ID:値` の形を作るためと、返事の中の ID を伏せるために使う。
  add(value, { id = "" } = {}) {
    if (typeof value !== "string" || value.length === 0) return;
    if (typeof id === "string" && id.length > 0) this.#ids.add(id);
    if (this.#entries.some((e) => e.value === value && e.id === id)) return;
    this.#entries.push({ value, id });
  }

  entries() {
    return this.#entries.map((e) => ({ value: e.value, id: e.id }));
  }

  // 入力係が入れた ID の一覧（返事の中で伏せる物）。
  ids() {
    return [...this.#ids];
  }

  get size() {
    return this.#entries.length;
  }

  clear() {
    this.#entries = [];
    this.#ids = new Set();
  }
}
