// login の流れ（設計書 3 節・実装仕様「login の流れ」）。値はこのファイルの手元の変数にだけ置き、終わったら消す。
import { attrsToMap } from "./browser.mjs";
import { MIN_NEEDLE } from "./leak-guard.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Changed extends Error {}

const FRAME_TAGS = new Set(["IFRAME", "FRAME", "OBJECT", "EMBED"]);

const typeOf = (el) => (el.attrs.get("type") ?? "").trim().toLowerCase();

function isLoopbackHttp(u) {
  return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
}

// DOM の木（最上位の文書だけ。iframe の中へは入らない）を、文書順の一覧にする。
function indexDocument(root) {
  const els = [];
  let frames = 0;
  let passwordInFrames = 0;
  const countPasswords = (n) => {
    let c = 0;
    const w = (x) => {
      if (!x) return;
      if (x.nodeType === 1 && x.nodeName === "INPUT" && (attrsToMap(x.attributes).get("type") ?? "").trim().toLowerCase() === "password") c++;
      for (const ch of x.children ?? []) w(ch);
      if (x.contentDocument) w(x.contentDocument);
    };
    w(n);
    return c;
  };
  const walk = (n, parent) => {
    let p = parent;
    if (n.nodeType === 1) {
      const el = { node: n, parent, name: String(n.nodeName).toUpperCase(), attrs: attrsToMap(n.attributes), index: els.length };
      els.push(el);
      p = el;
      if (FRAME_TAGS.has(el.name)) {
        frames++;
        if (n.contentDocument) passwordInFrames += countPasswords(n.contentDocument);
      }
    }
    for (const c of n.children ?? []) walk(c, p);
  };
  walk(root, null);
  const byId = new Map();
  for (const el of els) {
    const id = el.attrs.get("id");
    if (id && !byId.has(id)) byId.set(id, el);
  }
  return { els, byId, frames, passwordInFrames };
}

function ownerForm(el, byId) {
  if (el.attrs.has("form")) {
    const f = byId.get(el.attrs.get("form"));
    return f && f.name === "FORM" ? f : null;
  }
  for (let p = el.parent; p; p = p.parent) if (p.name === "FORM") return p;
  return null;
}

// 確かめ（1Password にはまだ触らない）。戻り値: {ok:false,status,reason} か {ok:true, plan}
export async function inspectPage(browser, cfg, site) {
  const fail = (status, reason) => ({ ok: false, status, reason });
  const frame = await browser.frame();
  let u;
  try {
    u = new URL(frame.url);
  } catch {
    return fail("mismatch", "画面の住所を読めない");
  }
  if (u.username || u.password) return fail("mismatch", "住所にユーザー名・パスワードが付いている");
  if (!(u.protocol === "https:" || (cfg.allowHttpLoopback && isLoopbackHttp(u)))) return fail("mismatch", "画面が https ではない");
  if (u.origin !== site.origin) return fail("mismatch", "画面の origin が項目の origin と違う");

  const root = await browser.getDocument();
  const { els, byId, frames, passwordInFrames } = indexDocument(root);
  const pws = els.filter((e) => e.name === "INPUT" && typeOf(e) === "password");
  if (pws.length === 0) {
    return fail("not_found", frames > 0 || passwordInFrames > 0 ? "パスワード欄が無い（iframe の中の欄には入れない）" : "パスワード欄が無い");
  }
  if (pws.length > 1) return fail("not_found", "パスワード欄が 2 つ以上ある");
  const pw = pws[0];

  const form = ownerForm(pw, byId);
  const inForm = (el) => ownerForm(el, byId) === form;

  // ユーザー名の欄: 同じ form（無ければ文書）で、パスワード欄より前にある最後の text・email・tel・種類なし
  let user = null;
  for (const el of els) {
    if (el.index >= pw.index) break;
    if (el.name !== "INPUT" || !inForm(el)) continue;
    const t = typeOf(el);
    if (t === "" || t === "text" || t === "email" || t === "tel") user = el;
  }

  // 送信ボタン: 同じ form の最初の button[type=submit]・種類なしの button・input[type=submit|image]
  let submit = null;
  if (form) {
    for (const el of els) {
      if (!inForm(el)) continue;
      const t = typeOf(el);
      if ((el.name === "BUTTON" && (t === "submit" || t === "")) || (el.name === "INPUT" && (t === "submit" || t === "image"))) {
        submit = el;
        break;
      }
    }
  }

  if (form) {
    const rawAction = (submit?.attrs.get("formaction") ?? form.attrs.get("action") ?? "").trim();
    // Kitesurf が <base href> を反映しているか分からないので、<base> の href で解いた物も全部確かめる
    const bases = [frame.url, root.baseURL].filter(Boolean);
    for (const el of els) {
      if (el.name !== "BASE" || !el.attrs.has("href")) continue;
      try {
        bases.push(new URL(el.attrs.get("href"), frame.url).href);
      } catch {
        return fail("mismatch", "base の住所を読めない");
      }
    }
    const baseSet = [...new Set(bases)];
    const targets = rawAction === "" ? [frame.url] : [];
    if (rawAction !== "") {
      for (const b of baseSet) {
        try {
          targets.push(new URL(rawAction, b).href);
        } catch {
          return fail("mismatch", "フォームの送り先を読めない");
        }
      }
    }
    for (const t of targets) {
      let tu;
      try {
        tu = new URL(t);
      } catch {
        return fail("mismatch", "フォームの送り先を読めない");
      }
      if (tu.origin !== site.origin) return fail("mismatch", "フォームの送り先の origin が項目の origin と違う");
    }
    const method = (submit?.attrs.get("formmethod") ?? form.attrs.get("method") ?? "").trim().toLowerCase();
    if (method !== "post" && !site.allowGetForm) return fail("error", "GET で送るフォームは値が住所に出るので使わない");
  }

  return {
    ok: true,
    plan: {
      loaderId: frame.loaderId,
      url: frame.url,
      pwId: pw.node.backendNodeId,
      userId: user ? user.node.backendNodeId : null,
      submitId: submit ? submit.node.backendNodeId : null,
    },
  };
}

function detectTwoFactor(root) {
  const { els } = indexDocument(root);
  return els.some((e) => {
    if (e.name !== "INPUT") return false;
    if ((e.attrs.get("autocomplete") ?? "").toLowerCase().includes("one-time-code")) return true;
    const s = `${e.attrs.get("name") ?? ""} ${e.attrs.get("id") ?? ""}`.toLowerCase();
    return /otp|2fa|totp|code/.test(s);
  });
}

const cleanReason = (s) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 100);

// 切る前の元の文字（住所の全体・題名）を、返事に付けずに持たせる。leak-guard で返事ごと照合するため。
function withRaw(r, info) {
  Object.defineProperty(r, "raw", { value: [info?.rawUrl, info?.title].filter((x) => typeof x === "string" && x), enumerable: false });
  return r;
}

// 承認の後・送る直前に同じ調べ直しをして、控え（plan）と比べる。違えば理由の文、同じなら null。
async function planDiff(browser, cfg, site, plan) {
  const again = await inspectPage(browser, cfg, site).catch(() => ({ ok: false }));
  if (
    !again.ok ||
    again.plan.loaderId !== plan.loaderId ||
    again.plan.url !== plan.url ||
    again.plan.pwId !== plan.pwId ||
    again.plan.userId !== plan.userId ||
    again.plan.submitId !== plan.submitId
  ) {
    return "画面が変わった";
  }
  const d = await browser.describe(plan.pwId);
  if (!d || d.nodeName !== "INPUT" || (d.attrs.get("type") ?? "").trim().toLowerCase() !== "password") return "パスワード欄が変わった";
  return null;
}

// deps: {browser, cfg, store, provider, notify, log}
export async function login(deps, { site: siteName, reason }) {
  const { browser, cfg, store, provider, notify, log } = deps;
  const site = cfg.sites.find((s) => s.name === siteName);
  const base = async (status, why, extra = {}) => {
    let info = { url: "", title: "" };
    try {
      info = await browser.info();
    } catch {}
    return withRaw({ status, reason: why, url: info.url, title: info.title, twoFactor: false, ...extra }, info);
  };
  if (!site) return base("not_found", "そのサイトは一覧に無い");

  let creds = null;
  let plan = null;
  const filled = [];
  try {
    // 2. 確かめる
    const first = await inspectPage(browser, cfg, site);
    if (!first.ok) return await base(first.status, first.reason);
    plan = first.plan;

    // 3. 通知（失敗で止めない）
    const note = `Kitesurf のログイン: ${site.origin} に ${site.op.item} を入れます。理由（AI が書いた文）: ${cleanReason(reason)}`;
    const nres = await Promise.race([
      notify({ enabled: cfg.notify, title: "Kitesurf のログイン", body: note }).catch(() => "failed"),
      sleep(3000).then(() => "pending"),
    ]);
    log?.write({ notify: nres === "skipped" ? "skipped" : nres });

    // 4. 値を頼む
    const got = await provider({
      item: site.op.item,
      vault: site.op.vault,
      account: site.op.account,
      timeoutMs: cfg.approvalTimeoutMs,
      opCmd: cfg.opCmd,
    });
    if (got.status !== "ok") {
      const why = {
        denied: "本人が断った",
        timeout: "1Password の許可が時間内に無かった",
        not_found: "1Password に項目が無い",
        error: "値を取れなかった",
      }[got.status];
      return await base(got.status, why ?? "値を取れなかった");
    }
    creds = got;

    // 5. 項目の住所
    const urlOk = creds.urls.some((h) => {
      try {
        return new URL(h).origin === site.origin;
      } catch {
        return false;
      }
    });
    if (!urlOk) return await base("mismatch", "項目の住所に、このサイトの origin が無い");

    // 5b. 短いパスワードは照合で探せない（leak-guard は MIN_NEEDLE 文字未満を探さない）ので、入れる前に値を捨てて断る
    if (creds.password.length < MIN_NEEDLE) {
      creds.password = "";
      creds.username = "";
      return await base("error", "パスワードが短くて見張れないので入れない");
    }

    // 6. 承認の後に確かめ直す（同じ検査をもう一度して、欄が同じ物である事も見る）
    const diff = await planDiff(browser, cfg, site, plan);
    if (diff !== null) {
      return await base("changed", diff === "画面が変わった" ? "承認を待つ間に画面が変わったので入れない" : "承認を待つ間にパスワード欄が変わったので入れない");
    }

    // 7. 照合用に持つ。入れる欄を覚える
    store.add(creds.password, { id: creds.username });
    if (plan.userId !== null) browser.markProtected(plan.loaderId, plan.userId);
    browser.markProtected(plan.loaderId, plan.pwId);

    const stillSame = async () => {
      const f = await browser.frame();
      if (f.loaderId !== plan.loaderId || f.url !== plan.url) throw new Changed();
    };

    // 8. 入れる
    if (plan.userId !== null && creds.username) {
      await stillSame();
      filled.push(plan.userId);
      await browser.focus(plan.userId);
      await browser.clearField(plan.userId);
      await browser.insertText(creds.username);
    }
    await stillSame();
    filled.push(plan.pwId);
    await browser.focus(plan.pwId);
    await browser.clearField(plan.pwId);
    await browser.insertText(creds.password);

    // 9. change を出す
    for (const id of filled) await browser.fireChange(id);

    // 10. 送る。直前に、承認の後と同じ調べ直しと比較をもう一度する（違えば中止して changed）
    await stillSame();
    if ((await planDiff(browser, cfg, site, plan)) !== null) throw new Changed();
    if (plan.submitId !== null) {
      await browser.clickNode(plan.submitId);
    } else {
      await browser.focus(plan.pwId);
      await browser.pressKey("Enter");
    }

    // 11. 移動を待つ
    await browser.waitNavigation(plan.loaderId, { noStartMs: 1500, extraMs: 1000, maxLoadMs: 15000 });

    // 13. 返す（片付けは finally。ここでは先に二段階認証の欄を調べる）
    const info = await browser.info();
    let twoFactor = false;
    try {
      twoFactor = detectTwoFactor(await browser.getDocument());
    } catch {}
    return withRaw({ status: "submitted", reason: "", url: info.url, title: info.title, twoFactor }, info);
  } catch (e) {
    if (e instanceof Changed) return await base("changed", "入れている間に画面が変わったので中止した");
    const r = await base("error", "内部の誤り");
    Object.defineProperty(r, "errKind", { value: e?.name ?? "Error", enumerable: false });
    return r;
  } finally {
    // 12. 片付ける
    if (plan && filled.length && !cfg.guardDisabled) {
      try {
        const f = await browser.frame();
        if (f.loaderId === plan.loaderId) for (const id of filled) await browser.clearField(id).catch(() => {});
      } catch {}
    }
    if (creds) {
      creds.password = "";
      creds.username = "";
      creds = null;
    }
  }
}
