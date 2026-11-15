// 入力係の記録。決まった項目だけを 1 行 1 JSON で書く。書く前に leak-guard を通す。
// 道具の引数・CDP の引数・例外の文は書かない。
import { mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";

const ALLOWED = ["tool", "status", "ms", "origin", "notify"];

export class GateLog {
  #file;
  #guard;
  #ready = false;

  constructor({ dir, guard }) {
    this.#file = path.join(dir, "gate.log");
    this.#dir = dir;
    this.#guard = guard;
  }
  #dir;

  write(fields = {}) {
    const rec = { t: new Date().toISOString() };
    for (const k of ALLOWED) {
      if (fields[k] === undefined) continue;
      const v = fields[k];
      rec[k] = typeof v === "number" || typeof v === "string" ? v : String(v);
    }
    let line = JSON.stringify(rec);
    if (this.#guard && this.#guard.hasLeak(line)) line = JSON.stringify({ t: rec.t, blocked: true });
    try {
      if (!this.#ready) {
        mkdirSync(this.#dir, { recursive: true });
        this.#ready = true;
      }
      appendFileSync(this.#file, line + "\n");
    } catch {
      // 記録の失敗で道具を止めない。理由（値が入りうる）は出さない。
      try {
        process.stderr.write("gate-log: 書けない\n");
      } catch {}
    }
  }
}
