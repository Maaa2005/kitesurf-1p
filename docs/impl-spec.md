# 最初の版の作り方（実装の仕様）

設計書 `docs/design.md` を実装に落とした仕様。設計書と食い違う時は設計書が正。ここで新しく決めた事は設計書の 8 節にも書く。

## 置き場と分担

```
package.json          依存: @modelcontextprotocol/sdk 1.32.2・puppeteer-core 25.17.0・zod 4.6.7（入れ済み）
src/                  入力係（Windows の Node 24 で動かす）
  config.mjs          環境変数とサイト一覧の読み込み
  mutex.mjs           道具を 1 本ずつ通す鍵
  secret-store.mjs    値を照合用にだけメモリに持つ（入力係が終わるまで。ファイルには書かない）
  leak-guard.mjs      返事と記録の中を、値と形を変えた値で探す
  id-mask.mjs         返事の文字の中の ID を「(ID)」に置き換える
  log.mjs             入力係の記録（決まった項目だけ・書く前に leak-guard を通す）
  browser.mjs         Kitesurf との接続（puppeteer-core と CDP の小さな関数）
  snapshot.mjs        アクセシビリティの木から値を消した一覧を作る
  notify.mjs          Windows の通知
  provider.mjs        使い捨ての子プロセス op-child.mjs を起動して値を受け取る
  op-child.mjs        op（本物の op.exe か偽の op）を呼ぶ使い捨てのプロセス
  resolve-cmd.mjs     名前だけの命令を PATH の絶対の住所のフォルダだけから探す
  proc.mjs            Windows の道具の絶対の住所・安全な作業フォルダ・子と孫の停止
  login.mjs           login の流れ
  server.mjs          MCP サーバー（stdio）。道具の登録
test/fake-op.mjs      偽の op（op item get の形で合成の値を返す）
test/unit/            単体の試験（node:test）
test/site/server.mjs  試験用のサイト（WSL の Node 22 で動かす。依存なし）
test/lib/             試験の道具（MCP の記録係・漏れ探し・文字読み取り）
test/e2e/leak.mjs     設計書 5 節の漏れ試験
scripts/real-op-check.mjs  本物の 1Password で利用者が 1 回だけ回す確かめ
scripts/kitesurf-dev.sh    Kitesurf を記録付きで起動（WSL）
```

## 環境変数（入力係）

| 名前 | 既定 | 意味 |
|---|---|---|
| `KS1P_KITESURF_WS` | `ws://127.0.0.1:8787/devtools/browser` | Kitesurf の CDP。番号を変える時は Kitesurf 本体の `KITESURF_PORT`（既定 8787）と同じ番号にそろえる。`ws:` で、ホストは `127.0.0.1`・`[::1]`・`localhost` だけ（違えば起動しない） |
| `KS1P_SITES` | `%APPDATA%\kitesurf-1p\sites.json` | ログインに使えるサイトの一覧（下） |
| `KS1P_OP_CMD` | `["op.exe"]` | op を呼ぶ命令（JSON の配列）。先頭が名前だけなら PATH の中の絶対の住所のフォルダだけから探す（作業フォルダは見ない。Windows は `.exe`・`.com` だけ）。相対の住所は使えない。試験では `["<node の絶対の住所>","<repo>/test/fake-op.mjs"]` |
| `KS1P_LOG_DIR` | `%LOCALAPPDATA%\kitesurf-1p\logs` | 入力係の記録の置き場（`gate.log`） |
| `KS1P_APPROVAL_TIMEOUT_MS` | `240000` | 1Password の許可を待つ長さ（4 分） |
| `KS1P_NOTIFY` | `on` | `off` で通知を出さない（記録に `notify:skipped` だけ書く） |
| `KS1P_ALLOW_HTTP_LOOPBACK` | 未設定 | `KS1P_TEST_MODE=1` と両方ある時だけ、127.0.0.1・localhost の http を https と同じに扱う（試験用） |
| `KS1P_TEST_MODE` | 未設定 | `1` で試験用の動き（下の 2 つを許す） |
| `KS1P_TEST_DISABLE_GUARD` | 未設定 | `KS1P_TEST_MODE=1` と両方あり、`KS1P_OP_CMD` の要素のどれかがこのリポの `test/fake-op.mjs` そのもの（住所を比べる）の時だけ、隠す処理を切る（対照の試験用） |

`KS1P_TEST_DISABLE_GUARD` が効いている時は、起動時に stderr へ警告を出し、すべての返事の先頭に `[TEST: guard disabled]` を付ける。頼まれたのに条件を満たさない時は、効かせずに stderr へ警告を出す。

`NODE_DEBUG` が空でなければ、入力係は理由を stderr に 1 行書いて起動しない（Puppeteer がブラウザへ送った内容を stderr に出すため）。接続でも Puppeteer の記録を切る（`logger: () => undefined`）。`KS1P_SECRET_TTL_MS` は使われなくなった（設定されていれば警告だけ出す）。

### サイトの一覧（`KS1P_SITES`）

```json
[{ "name": "test-a", "origin": "http://127.0.0.1:9921",
   "op": { "item": "kitesurf-1p-test", "vault": "Private", "account": "" },
   "allowGetForm": false }]
```

`op.item`・`op.vault`・`op.account` が `-` で始まる物は読み込みの誤りにする（op のオプションと取り違えるため）。`login_sites` はこの一覧から `name` と `origin` だけを返す。1Password には触らない（一覧を出すたびに許可が要らないように）。

## MCP の道具（AI に渡す物はこれだけ）

すべての道具は `mutex` を通して 1 本ずつ動く。`login` は始めから返すまで鍵を持つので、その間の他の道具は待つ。返事はすべて `content: [{type:"text", text}]`（screenshot は image も）。返す前に必ず `leak-guard` を通し、値が見つかったら返事ごと捨てて `isError: true`・`text: "error: 返事に保護した値が含まれる恐れがあるため返さない"` にする。

| 道具 | 引数 | 返す text |
|---|---|---|
| `open` | `url`（http・https・about:blank だけ。user:pass@ の付いた住所は断る） | `url: <origin+path>\ntitle: <題名>` |
| `snapshot` | なし | 下の形 |
| `click` | `ref`（数） | `url: ..\ntitle: ..` |
| `type` | `ref`・`text` | `ok` |
| `press` | `key`（Enter・Tab・Escape・Backspace・ArrowUp/Down/Left/Right） | `url: ..\ntitle: ..` |
| `screenshot` | なし | 条件を満たせば image/png と `url: ..`。満たさなければ `isError` で理由 |
| `login_sites` | なし | `[{"name":..,"origin":..}]` の JSON |
| `login` | `site`・`reason`（100 字で切る） | `{"status":..,"reason":..,"url":..,"title":..,"twoFactor":bool}` の JSON |

住所はどこでも `origin + pathname` だけを返す（? と # の後ろを落とす）。

### snapshot の形

```
url: http://127.0.0.1:9921/login-post
title: ログイン
[1] textbox "ユーザー名" value="(入力済み)"
[2] textbox "パスワード" value="(空)"
[3] button "ログイン"
text: ようこそ
```

- アクセシビリティの木（`Accessibility.getFullAXTree`）の `role`・`name`・`value` から作る。番号は操作できる役（textbox・searchbox・combobox・button・link・checkbox・radio・menuitem・tab・option・switch・slider・spinbutton）だけに付ける。番号は `backendDOMNodeId` と、その時の文書（最上位の frame の `loaderId`）に結び付け、移動したら古い番号は `error: ref が古い。snapshot を取り直す`。
- 次の欄は `value` を出さず、値があれば `(入力済み)`、無ければ `(空)` と書く: DOM で今 `type=password` の input（`DOM.describeNode` の属性で見る）、入力係が `login` で値を入れた欄（`backendDOMNodeId` で覚える。ページが後から種類を text に変えても消す）。
- 全体を 20,000 字で切る。

## login の流れ（設計書 3 節の具体化）

1. 鍵を取る。`site` が一覧に無ければ `not_found`。
2. 確かめる（1Password にはまだ触らない）。順に:
   - 最上位の frame の住所（`Page.getFrameTree`）が https（`KS1P_ALLOW_HTTP_LOOPBACK=1` なら 127.0.0.1・localhost の http も可）。user:pass@ が付いていない。違えば `mismatch`。
   - その origin が一覧の `origin` と完全に同じ。違えば `mismatch`。
   - 最上位の文書だけで（iframe の中は見ない）`input[type=password]` がちょうど 1 つ。無い・2 つ以上なら `not_found`（iframe の中にだけある時は理由に「iframe の中の欄には入れない」）。
   - パスワード欄の form（祖先の form か `form` 属性）があれば、送り先（`action` を文書の住所で解いた物。空なら文書の住所）の origin が同じ。違えば `mismatch`。送り方（`method`。無ければ GET）が GET なら、`allowGetForm` が無い限り `error`（理由「GET で送るフォームは値が住所に出るので使わない」）。
   - ユーザー名の欄: 同じ form（form が無ければ文書）の中で、パスワード欄より前にある最後の text・email・tel・種類なしの input。無くてもよい。
   - 送信ボタン: 同じ form の中の最初の `button[type=submit]`・種類なしの button・`input[type=submit|image]`。無ければ Enter で送る。
   - 今の `loaderId`・住所・欄の `backendDOMNodeId` を控える。
3. 通知（`notify.mjs`）: 「Kitesurf のログイン: <origin> に <項目名> を入れます。理由（AI が書いた文）: <reason>」。PowerShell で Windows のトースト通知を出す。文は環境変数で渡し、XML として逃がす。通知の失敗で止めない。
4. 値を頼む（`provider.mjs`）。待つ長さは `KS1P_APPROVAL_TIMEOUT_MS`。結果が `denied`・`timeout`・`not_found`・`error` ならそのまま返す。
5. 項目の住所（`urls`）に一覧の `origin` と同じ origin が 1 つも無ければ、値を捨てて `mismatch`。パスワードが 4 文字未満なら、値を捨てて `error`（見張れないため）。
6. 承認の後に確かめ直す: 1 と同じ調べをもう一度して控えと比べ（送り先・送信ボタン・欄）、`loaderId` と住所が控えと同じで、パスワード欄が `DOM.describeNode` で引けて type=password のまま。違えば値を捨てて `changed`。
7. パスワードと ID を `secret-store` に入れる（入力係が終わるまで）。入れる欄を「入力係が入れた欄」として覚える。
8. 入れる: 欄ごとに、直前に `loaderId` と住所を確かめ直し（違えば中止して `changed`）、`DOM.focus`、欄を空にする（入力係だけの JS）、`Input.insertText`。ユーザー名→パスワードの順。
9. 入れた欄に `change` を出す（入力係だけの JS。`Runtime.callFunctionOn` で `dispatchEvent(new Event('change',{bubbles:true}))`）。
10. 送る直前に、6 と同じ調べと比較をもう一度する（違えば送らずに `changed`）。送信ボタンがあればその真ん中をマウスでクリック、無ければパスワード欄で Enter（`Input.dispatchKeyEvent`）。
11. 移動を待つ（始まれば読み込みが終わるまで最大 15 秒。1.5 秒たって始まらなければ JS で送る画面とみなし、さらに 1 秒待つ）。
12. 片付ける: 同じ文書のままなら、入れた欄を空にする。成功・失敗・例外のどれでも行う。手元の変数の値を消す（`secret-store` の照合用は残す）。
13. 返す: `submitted` と、送った後の住所（origin+path）・題名・二段階認証らしい欄があるか（`autocomplete=one-time-code`、または name・id が otp・2fa・totp・code を含む input）。

例外の時は `error`。例外の文はそのまま返さず、「内部の誤り」とだけ返す（記録には例外の種類だけ書く）。

結果の種類: `submitted`・`denied`・`timeout`・`mismatch`・`not_found`・`changed`・`error`。

## 値の取り出し（provider.mjs と op-child.mjs）

- `login` 1 回ごとに `node src/op-child.mjs <item> [--vault v] [--account a]` を新しく起動する（使い捨て。Windows の 1Password は呼んだプロセスごとに承認するので、毎回1Password の許可の画面が出る）。
- op-child は安全な作業フォルダ（Windows は `%SystemRoot%\System32`、他は `/`）で起動し、名前が `OP_` で始まる環境変数は渡さない（サービスアカウントなど、許可の画面を出さずに値が出る設定を使わせない）。
- op-child は `KS1P_OP_CMD` の命令に `item get <item> --format json --reveal`（`--vault`・`--account` があれば足す）を付けて起動し、shell は使わない。
- op の出力（項目の JSON）から、`purpose: "USERNAME"`（無ければ `id: "username"`）と `purpose: "PASSWORD"`（無ければ `id: "password"`）の `value`、`urls[].href` を取り、`{"username":..,"password":..,"urls":[..]}` の 1 行だけを stdout に書いて終わる。
- 失敗は終了番号で返す: 3=断られた（op の stderr に dismissed・denied・cancel・authorization のどれか）、4=項目が無い（isn't an item・not found・more than one）、5=その他。op の stderr はそのまま親に渡さない。
- provider は子の stdout をメモリでだけ受け、記録に書かない。期限を過ぎたら子と孫を止めて `timeout`（Windows は `%SystemRoot%` の `taskkill.exe /T /F /PID`。止められなければ stderr に 1 行）。
- op-child も、待つ長さ＋3 秒で孫の op を止めて 5 で終わる（`--timeout-ms` で受け取る）。入力係が終わる時（stdin が閉じた・SIGINT・SIGTERM）も、動いている子を止める。

## 偽の op（test/fake-op.mjs）

- `node test/fake-op.mjs item get <item> --format json --reveal [--vault v] [--account a]` を受ける。
- 環境変数 `FAKE_OP_DIR` の `items.json`（`{"<item>": <op の項目の JSON>}`）と `behavior.json`（`{"mode":"ok|deny|timeout|error","delayMs":0}`。無ければ ok・0）を読む。
- 呼ばれるたびに `calls.log` に `{"t":..,"item":..,"pid":..,"ppid":..,"cwd":..,"opEnvNames":[..]}` を 1 行足す（値は書かない。`opEnvNames` は受け取った環境のうち `OP_` で始まる名前だけ）。回数と「毎回違う子から呼ばれたか」の確かめに使う。
- ok: `delayMs` 待ってから項目の JSON を stdout へ。deny: stderr に `[ERROR] authorization prompt dismissed, please try again`・終了 1。timeout: 終わらない。error: stderr に `[ERROR] something went wrong`・終了 1。項目が無い: stderr に `[ERROR] "<item>" isn't an item.`・終了 1。
- 項目の JSON の形（本物の op 2.x と同じ形）:

```json
{"id":"fakeid","title":"kitesurf-1p-test","category":"LOGIN",
 "urls":[{"primary":true,"href":"http://127.0.0.1:9921"}],
 "fields":[{"id":"username","type":"STRING","purpose":"USERNAME","label":"username","value":"..."},
           {"id":"password","type":"CONCEALED","purpose":"PASSWORD","label":"password","value":"..."}]}
```

## leak-guard の探し方（入力係）

`secret-store` にある値それぞれについて、次の形を作り、返す文字（JSON にした物）の中を探す。大小文字は区別しない。

- そのまま、逆順
- URL: `encodeURIComponent`、フォームの形（空白を +）、%xx を小文字にした物
- JSON: `JSON.stringify(v).slice(1,-1)`、全部の文字を `\uXXXX` にした物
- HTML: `&amp; &lt; &gt; &quot; &#39;` に置き換えた物、全部の文字を `&#NN;` と `&#xHH;` にした物
- base64: 値・`<ID>:<値>` の普通の形と URL 用の形。前に 0・1・2 バイト付けて作り、ずれに左右されない真ん中の部分も探す
- 16 進（UTF-8 のバイト。小文字・大文字）

見つけたら返事ごと止めるのはパスワードだけ。ID はページが表示する事が多いので止めず、画像以外の返事の文字の中で「(ID)」に置き換える（4 文字以上の時。そのまま・URL・フォーム・JSON・`\uXXXX`・HTML の形。大小文字は区別しない）。置き換えるのは住所・題名・本文などの文字の値だけで、キー・`status`・真偽値は変えない。文字を短く切る前に置き換える。

文字を短く切る道具（snapshot の欄・文・全体、住所の `?` と `#` の後ろ）は、切る前の元の文字も照合する。4 文字未満の形は探さない（その長さのパスワードは入れない）。

## 画面写真の条件

隠す処理が効いている時、次を全部満たす時だけ撮って返す。

1. 入力係が入れた欄が今の文書に残っていれば、どれも空。
2. 今の画面の文字（アクセシビリティの木の JSON と `DOM.getOuterHTML` の文書全体）を leak-guard で探して 0 件。
3. 撮る間だけ、`input[type=password]` と入力係が入れた欄すべてに `color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important` を当て、撮った後に元に戻す。透明にできなければ撮らない。
4. 撮った後に 1・2 をもう一度確かめ、駄目なら（文書が変わっていた時も）画像を捨てる。

満たさない時は `isError` で「画面に保護した値が残っている恐れがあるため撮らない」。

## 入力係の記録（log.mjs）

`gate.log` に 1 行 1 JSON: `{"t":..,"tool":..,"status":..,"ms":..,"origin":..}`。道具の引数（`type` の text・`login` の reason を含む）、CDP の引数、例外の文は書かない。書く前に leak-guard を通し、見つかったら `{"t":..,"blocked":true}` だけ書く。stderr にも値を出さない。

## 試験（設計書 5 節）

`test/e2e/leak.mjs` が全部を回す。前提: Kitesurf が `scripts/kitesurf-dev.sh` で動いている（記録は `KS_LOG`、既定 `$HOME/dev/kitesurf-dev.log`）。番号を変える時は `KITESURF_PORT`（Kitesurf 側）と `KS1P_KITESURF_WS`（試験側。健康確認もこの host:port を使う）をそろえる。

- 試験用のサイト: WSL で `node <リポの WSL での住所>/test/site/server.mjs`。127.0.0.1:9921（A。項目の origin）と 127.0.0.1:9922（B。別の origin）。受けた要求を覚え、`GET /__records`・`POST /__reset` で出し入れする。受けた値を stdout に出さない。
- 入力係は `node src/server.mjs` を試験の記録係（`test/lib/mcp-client.mjs`）が起動し、行き帰りの JSON-RPC を 1 行ずつそのまま `transcript.jsonl` に残す。
- 漏れ探し（`test/lib/leak-scan.mjs`）は入力係の leak-guard と別に書く（同じ見落としを持たないため）。
- 置き場: `test/.run/<run>/secret/`（偽の op の項目など。探さない）、`test/.run/<run>/scan/`（記録・入力係の記録・stderr。探す）、`test/.run/<run>/shots/`（写真と文字読み取りの結果）。
- 文字読み取りは WSL の tesseract 5.3.4（Ubuntu の公式の置き場から入れた）。

## 試験の一覧（test/e2e/leak.mjs）

範囲は 2026-11-16 に決めた。罠のページを使う試験（設計書 5 節の 6・10・11・12）は、この版では回さない。番号は元のまま（T5〜T7 は欠番）。

値は 1 回の試験ごとに作り直す。本番用と対照用で別の値にする（対照で漏らした値を本番の探しで拾わないため）。

- `S`: パスワード。24 字・英数字と記号（`!#$%&*+-=?@^_~"'<>/\` から 3 字以上）と日本語 3 字以上と絵文字 1 字。
- `U`: ID（`user-` と英数字 8 字）。
- `Socr`: 写真の試験用のパスワード。16 字・`A-HJ-NP-Z2-9`（読み間違えやすい字を除く）。
- `Cai`: AI が自分で打つ文字（16 字・`A-HJ-NP-Z2-9`）。
- `Cctl`: 置いて確かめる対照の文字。

入力係は 3 通りで起動する: 本番（`KS1P_TEST_MODE=1`・`KS1P_ALLOW_HTTP_LOOPBACK=1`・`KS1P_NOTIFY=off`・`KS1P_APPROVAL_TIMEOUT_MS=3000`）、対照（本番＋`KS1P_TEST_DISABLE_GUARD=1`）、https 必須（本番から `KS1P_ALLOW_HTTP_LOOPBACK` を抜く）。

| 番号 | 設計書 5 節 | 中身 | 合格 |
|---|---|---|---|
| T1 | 1・8・9 | 対照: 対照の入力係で login-js に login → snapshot・screenshot。big の画面で AI が `Cai` を打って撮る。Kitesurf の記録には `?c=Cctl` の住所を開いて出す。入力係の記録・一時ファイル・Kitesurf の保存領域には `Cctl` の形を変えた物を置く | 記録係の記録に対照の `S` が出る・文字読み取りで `Socr` と `Cai` が読める（8 字以上続けて一致）・各場所で `Cctl` が見つかる |
| T2 | 2・3 | 本番で login-post・login-js・login-enter に login | 全部 `submitted`・受け口の ID とパスワードが `U`・`S` と完全に一致・続く snapshot と screenshot が値なしで返る |
| T3 | 4 | 断る: localhost の名前・B のポート・住所の途中に A を含む B・https 必須で http・iframe（別 origin と同じ origin）・パスワード欄 2 つ・無し・送り先が B・GET（明示と既定）・一覧に無い名前・項目の住所が B | 決めた種類で断る・偽の op の呼び出し 0 回（項目の住所が B の時だけ 1 回で値を捨てる）・受け口に何も届かない |
| T4 | 5 | 承認待ちの間にページが移る・欄が入れ替わる（偽の op を 1.5 秒待たせる）。断る・4 分の代わりに 3 秒で打ち切り | `changed`・`changed`・`denied`・`timeout`・受け口に何も届かない |
| T8 | 7 | login の最中（偽の op 1.5 秒）に snapshot・screenshot・click を同時に呼ぶ | 他の道具の返事が login の返事より後・記録係の記録に 0 件 |
| T9 | 8 | 本番: big の画面で `Socr` を login・撮る。AI が `Cai` をパスワード欄に打って撮る | 文字読み取りで `Socr`・`Cai` が 8 字以上続けて出ない |
| T10 | 2 | 最後に、本番の全部の場所を `S`・`Socr` の全部の形で探す（記録係の記録・入力係の記録と stderr・Kitesurf の記録の今回分・Windows の一時フォルダと WSL の /tmp と Kitesurf の .wrangler の今回変わったファイル） | 全部 0 件。対照（T1）が通らなかった場所は「対照なし」と書き、0 件を合格にしない |
| T11 | 13 | T1〜T4・T8〜T10 を新しい値で 3 回 | 3 回とも全部合格 |

ほかに、login のたびに偽の op を呼んだ親のプロセス（op-child）の番号が毎回違う事を `calls.log` で確かめる。結果は `test/.run/<run>/report.json`（値を書かない。report も探す対象）と、画面に表で出す。
