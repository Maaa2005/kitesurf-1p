// MCP サーバー（stdio）。AI に渡す道具はここに登録した物だけ。stdout は MCP の通信だけに使う。
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, nodeDebugProblem } from "./config.mjs";
import { maskIds, ID_MIN_LENGTH } from "./id-mask.mjs";
import { Mutex } from "./mutex.mjs";
import { SecretStore } from "./secret-store.mjs";
import { LeakGuard } from "./leak-guard.mjs";
import { GateLog } from "./log.mjs";
import { KitesurfBrowser, KsError, KEY_NAMES, originPath } from "./browser.mjs";
import { buildSnapshot, collectScreenTexts, findPasswordIds, RefTable } from "./snapshot.mjs";
import { notify as realNotify } from "./notify.mjs";
import { requestCredentials, killAllChildren } from "./provider.mjs";
import { login } from "./login.mjs";

const LEAK_TEXT = "error: 返事に保護した値が含まれる恐れがあるため返さない";
const TEST_PREFIX = "[TEST: guard disabled]\n";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true });
// raw: 切る前の元の文字（住所の全体・題名）。返さずに照合だけに使う。
// mask: 文字の値の中の ID を (ID) にする関数。値ごとに掛け、返事の形（キー・決まった語）は変えない。
const infoRes = (i, mask) => ({ ...text(`url: ${mask(i.url)}\ntitle: ${mask(i.title)}`), origin: mask(i.url), raw: [i.rawUrl, i.title] });

export function createGateway(cfg, overrides = {}) {
  const mutex = new Mutex();
  const store = new SecretStore();
  const guard = new LeakGuard(store);
  const log = new GateLog({ dir: cfg.logDir, guard });
  const browser = overrides.browser ?? new KitesurfBrowser({ ws: cfg.kitesurfWs });
  const refs = new RefTable();
  const provider = overrides.provider ?? requestCredentials;
  const notify = overrides.notify ?? realNotify;
  // 入力係が入れた ID（4 文字以上）を (ID) に置き換える。隠す処理を切った対照では置き換えない。
  const mask = (s) => {
    if (cfg.guardDisabled || typeof s !== "string") return s;
    return maskIds(
      s,
      store.ids().filter((i) => i.length >= ID_MIN_LENGTH),
    );
  };

  // ---- 道具の中身。{content, isError?, status?, origin?} を返す ----
  const tools = {
    async open({ url }) {
      let u;
      if (url === "about:blank") u = url;
      else {
        try {
          const p = new URL(url);
          if (p.protocol !== "http:" && p.protocol !== "https:") return fail("error: http・https・about:blank の住所だけ開ける");
          if (p.username || p.password) return fail("error: user:pass@ の付いた住所は開かない");
          u = p.href;
        } catch {
          return fail("error: 住所の形が正しくない");
        }
      }
      await browser.navigate(u);
      return infoRes(await browser.info(), mask);
    },

    async snapshot() {
      const s = await buildSnapshot(browser, { hide: !cfg.guardDisabled, mask });
      refs.replace(s.refs);
      return { ...text(s.text), origin: mask(originPath((await browser.frame()).url)), raw: s.raw };
    },

    async click({ ref }) {
      const f = await browser.frame();
      const r = refs.resolve(ref, f.loaderId);
      if (!(await browser.describe(r.backendNodeId))) throw new KsError("ref が古い。snapshot を取り直す");
      await browser.clickNode(r.backendNodeId);
      await browser.waitNavigation(f.loaderId, { noStartMs: 800, maxLoadMs: 15000 });
      return infoRes(await browser.info(), mask);
    },

    async type({ ref, text: value }) {
      const f = await browser.frame();
      const r = refs.resolve(ref, f.loaderId);
      const d = await browser.describe(r.backendNodeId);
      if (!d) throw new KsError("ref が古い。snapshot を取り直す");
      if (d.nodeName !== "INPUT" && d.nodeName !== "TEXTAREA") throw new KsError("その部品には入力できない");
      await browser.focus(r.backendNodeId);
      await browser.clearField(r.backendNodeId);
      await browser.insertText(value);
      await browser.fireChange(r.backendNodeId);
      return { ...text("ok"), origin: mask(originPath(f.url)), raw: [f.url] };
    },

    async press({ key }) {
      const f = await browser.frame();
      await browser.pressKey(key);
      await browser.waitNavigation(f.loaderId, { noStartMs: 800, maxLoadMs: 15000 });
      return infoRes(await browser.info(), mask);
    },

    async screenshot() {
      const refuse = () => fail("error: 画面に保護した値が残っている恐れがあるため撮らない");
      const f = await browser.frame();
      const origin = mask(originPath(f.url));
      let data;
      if (cfg.guardDisabled) {
        data = await browser.screenshotPng();
      } else {
        const mine = browser.protectedIds(f.loaderId);
        // 撮る前と撮った後に、同じ確かめをする。
        const safe = async () => {
          // 1. 入力係が入れた欄が今の文書に残っていれば、どれも空
          for (const id of mine) {
            if (!(await browser.describe(id))) continue;
            const n = await browser.valueLength(id).catch(() => 1);
            if (n !== 0) return false;
          }
          // 2. 今の画面の文字に保護した値が無い
          return !guard.hasLeak(...(await collectScreenTexts(browser)));
        };
        if (!(await safe())) return refuse();
        // 3. 撮る間だけ password の欄と入れた欄を透明にする。透明にできなければ撮らずに誤りを返す（withTransparent が投げる）
        const live = [];
        for (const id of mine) if (await browser.describe(id)) live.push(id);
        const ids = new Set([...findPasswordIds(await browser.getDocument()), ...live]);
        data = await browser.withTransparent([...ids], () => browser.screenshotPng());
        // 4. 撮った後にも同じ確かめ。駄目なら画像を捨てる
        const f2 = await browser.frame();
        if (f2.loaderId !== f.loaderId || !(await safe())) {
          data = undefined;
          return refuse();
        }
      }
      return {
        content: [
          { type: "image", data, mimeType: "image/png" },
          { type: "text", text: `url: ${origin}` },
        ],
        origin,
        raw: [f.url],
      };
    },

    async login_sites() {
      return text(JSON.stringify(cfg.sites.map((s) => ({ name: s.name, origin: s.origin }))));
    },

    async login({ site, reason }) {
      const r = await login({ browser, cfg, store, provider, notify, log }, { site, reason });
      let origin;
      try {
        origin = r.url ? new URL(r.url).origin : undefined;
      } catch {}
      // ID を置き換えるのは、ページ由来の文字の値（url・title）だけ。キー・status・reason・真偽値は変えない（JSON の形を壊さない）
      const shown = { ...r, url: mask(r.url), title: mask(r.title) };
      return { ...text(JSON.stringify(shown)), status: r.status, origin: mask(origin), errKind: r.errKind, raw: r.raw };
    },
  };

  // ---- 共通の枠: 鍵・守り・記録 ----
  async function call(name, args = {}) {
    return mutex.run(async () => {
      const t0 = Date.now();
      let res;
      let status = "ok";
      let errKind;
      try {
        res = await tools[name](args);
        if (res.isError) status = "error";
        else if (res.status) status = res.status;
        errKind = res.errKind;
      } catch (e) {
        status = "error";
        errKind = e?.name ?? "Error";
        res = fail(e instanceof KsError ? `error: ${e.message}` : "error: 内部の誤り");
      }
      // ID の置き換えは各道具が、文字の値ごとに切る前に済ませている（返事全体の文字は置き換えない。形が壊れるため）
      const origin = res.origin;

      if (!cfg.guardDisabled) {
        const parts = res.content.filter((c) => c.type !== "image");
        // res.raw: 切る前の元の文字。切れ目にまたがる値を見逃さないため、これも照合する
        const raws = (res.raw ?? []).filter((x) => typeof x === "string");
        if (guard.hasLeak(...parts.map((c) => c.text ?? ""), JSON.stringify(parts), ...raws)) {
          res = fail(LEAK_TEXT);
          status = "blocked";
        }
      } else {
        res = { ...res, content: res.content.map((c) => (c.type === "text" ? { ...c, text: TEST_PREFIX + c.text } : c)) };
      }
      log.write({ tool: name, status: errKind && status === "error" ? `error:${errKind}` : status, ms: Date.now() - t0, origin });
      return { content: res.content, ...(res.isError ? { isError: true } : {}) };
    });
  }

  return { call, tools, store, guard, browser, log, mutex };
}

export function buildMcpServer(gw) {
  const server = new McpServer({ name: "kitesurf-1p", version: "0.1.0" });
  const reg = (name, description, inputSchema) =>
    server.registerTool(name, { description, inputSchema }, async (args) => gw.call(name, args));

  reg("open", "指定した住所（http・https・about:blank だけ）を開く。開いた後の住所と題名を返す。", { url: z.string() });
  reg("snapshot", "画面の文字と操作できる部品の一覧（番号付き）を返す。パスワード欄の値は出ない。", {});
  reg("click", "snapshot の番号の部品を押す。結果の住所と題名を返す。", { ref: z.number().int() });
  reg("type", "snapshot の番号の入力欄に文字を入れる（今の中身は置き換える）。パスワードは login を使う。", {
    ref: z.number().int(),
    text: z.string(),
  });
  reg("press", "キーを押す。", { key: z.enum(KEY_NAMES) });
  reg("screenshot", "画面写真（PNG）を返す。保護した値が画面にある恐れがある時は返さない。", {});
  reg("login_sites", "ログインに使えるサイトの名前と origin の一覧を返す。", {});
  reg("login", "一覧のサイトにログインする。値は入力係が 1Password から取り、AI は見ない。reason は 100 字で切る。", {
    site: z.string(),
    reason: z.string(),
  });
  return server;
}

async function main() {
  // 依存の詳細ログ（NODE_DEBUG）が有効だと、入れる値が stderr に出る恐れがある。起動しない。
  const dbg = nodeDebugProblem();
  if (dbg) {
    process.stderr.write(`起動しない: ${dbg}\n`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    process.stderr.write(`設定の誤り: ${e.message}\n`);
    process.exit(2);
  }
  if (cfg.guardDisabled) process.stderr.write("警告: KS1P_TEST_DISABLE_GUARD が有効。隠す処理を切っている（試験用）\n");
  if (cfg.guardDisableRequestedWithoutTestMode) process.stderr.write("KS1P_TEST_DISABLE_GUARD は KS1P_TEST_MODE=1 が無いと効かない（無視する）\n");
  if (cfg.guardDisableRequestedWithoutFakeOp) process.stderr.write("KS1P_TEST_DISABLE_GUARD は KS1P_OP_CMD にこのリポの test/fake-op.mjs が無いと効かない（無視する）\n");
  if (cfg.allowHttpLoopbackRequestedWithoutTestMode) process.stderr.write("KS1P_ALLOW_HTTP_LOOPBACK は KS1P_TEST_MODE=1 が無いと効かない（無視する）\n");
  if (cfg.secretTtlIgnored) process.stderr.write("KS1P_SECRET_TTL_MS は使われなくなった（値は入力係が終わるまでメモリに持つ）\n");

  const gw = createGateway(cfg);
  const server = buildMcpServer(gw);
  const transport = new StdioServerTransport();

  process.on("unhandledRejection", () => process.stderr.write("unhandledRejection\n"));
  process.on("uncaughtException", (e) => {
    process.stderr.write(`uncaughtException: ${e?.name ?? "Error"}\n`);
    process.exit(1);
  });
  // 動いている op-child は、入力係の終了（stdin が閉じた・SIGINT・SIGTERM・exit）でも止める
  process.on("exit", () => killAllChildren());
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    killAllChildren();
    await Promise.race([gw.browser.close(), new Promise((r) => setTimeout(r, 2000))]);
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
