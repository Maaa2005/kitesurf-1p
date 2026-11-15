# kitesurf-1p 設計書（2026-11-16）

Kitesurf（Cloudflare の軽い AI 用ブラウザ）に、1Password でのログインを足す道具の設計。

## 0. 決まっている形

- 誰の何: AI に自分のアカウントでサイトを操作させたい人。Chrome を丸ごと動かさずに軽く済ませ、AI にパスワードを見せない。
- 入れ方: Kitesurf の外に入力係を置く。AI は「このサイトにログインして」と頼むだけ。入力係が 1Password から値を取り、入力欄に直接入れる。AI は値を見ない。
- 動かす所: 最初の版は自分の PC だけ。パスワードを PC の外に出さず、無料で使える。
- 値の取り方: 1Password のアプリと公式の道具を使い、取るたびに利用者が 1Password で許可する（パスワードか指紋）。

## 1. 全体の形

```
AI（Claude Code など）
   │  MCP（決まった道具だけ。生の CDP は渡さない）
   ▼
入力係（kitesurf-1p。Windows の Node のプロセス 1 つ）
   ├─ CDP ──▶ Kitesurf（WSL の中・127.0.0.1:8787）
   └─ login のたびに使い捨ての子プロセス ── op.exe ──▶ 1Password アプリ（利用者の許可）
```

- 入力係だけが Kitesurf に CDP でつながる。AI は入力係の道具しか使わない。
- 入力係は Kitesurf の中身（画面の文字・入力欄・送信の中身）を自分で読み、値を隠してから AI に返す。
- 置き場所: 入力係は Windows、Kitesurf は WSL の Ubuntu（理由は 2 節の結論）。

## 2. 1Password からの取り出し方

### 公式文書で分かった事（Windows・2026-11-16 原文で確認）

出典: https://www.1password.dev/cli/app-integration-security （ページの更新 2026-11-11）

- 承認の単位: 「The session credential for Windows is an ID that's based on the PID of the process that invokes 1Password CLI, plus the start time.」「On Windows, commands executed in a sub-shell require separate authorization.」。Windows では、op を呼んだプロセスごとに承認が分かれる。Mac・Linux は端末の窓ごとで、子のシェルにも及ぶ。
- 続く時間: 「Authorization expires after 10 minutes of inactivity in the terminal session. There's a hard limit of 12 hours」。1Password アプリがロックされると、すべての承認が取り消される。
- 「取るたびに必ず承認」の設定は公式に無い。1Password の社員も 2025-06 に「今は無い」と答えている（1password.community の security-concern スレッド）。
- 同じ権限の物は守れない: 「A user or application with root/administrator level privileges on the same system may be able to circumvent one or more security measures」。
- 利用者の報告は食い違っている（Windows で op を呼ぶたびに承認が出る、という報告が 2023・2025 にある）。どちらの場合でも承認が増える側に倒れる作りにする。

### 入力係での取り方（Windows の分）

- `login` 1 回ごとに、使い捨ての子プロセスを作り、その中から op を呼ぶ。呼ぶ元のプロセスが毎回替わるので、毎回新しい承認（パスワードか指紋）が要る。入力係本体から直接 op を呼ぶと、入力係が 10 分間アカウント全体を読める状態になるので、それを避ける。
- 取った直後に、同じ子プロセスから `op signout` を呼んで承認を閉じる（公式の終了条件の 1 つ。Windows でも効くかは実機で確かめる）。
- 使う物は 1 件の項目の ID・パスワード・住所だけ。項目は `op item get <項目> --format json --reveal` で丸ごと取り（住所を確かめるため）、子プロセスの中で 3 つだけを抜き出して残りは捨てる。値は子プロセスの標準出力からメモリに受け、ファイル・引数・環境変数には置かない。
- AI が端末で動かす op は別のプロセスなので、入力係の承認には相乗りできない（Windows の規則による）。ただし AI が自分で op を呼べば、利用者の 1Password の許可の画面が別に出る。利用者は、入力係の通知（3 節の 2）が出ていない1Password の許可の画面を断る。
- 実機で 1 回確かめる（利用者の許可が要る）: 同じ子プロセスから 2 回・別の子プロセスから 1 回取り、1Password の許可の画面が出る回数を数える。1Password アプリの CLI の活動記録にも残る。

### もう 1 つの公式の道具: 1Password SDK のアプリ連携

- 2026-02 に正式になった（公式ブログ 2026-02-19「Following a four-month beta, SDK‑based integrations can now authenticate programmatically through our desktop password manager」）。JS の最新は 0.5.0（2026-07-31）。SDK 全体は「version 0」で、版を上げると壊れる事があるので固定して使う。
- 承認: 「Authorization occurs on a per-account and per-process basis.」「If the user runs multiple integrations, each process must be authorized separately.」（https://www.1password.dev/sdks/desktop-app-integrations ）。CLI と同じく、プロセスごとに承認が分かれ、10 分続く。
- 1Password の許可の画面に出る物: アカウント名、頼んだプロセスの名前（実行ファイルの名前）、範囲と期間。サイトの名前は出せない。node で作ると「node.exe」と出るので、AI が動かす別の node と見分けがつかない。
- 届く範囲: 承認すると、そのアカウントの全部の保管庫に届く（Personal も含む）。入力係の側で、取る項目を 1 件に絞る。
- Windows・Mac・Linux で使える。WSL の中からは使えない（公式 SDK の GitHub の Issue #235「1Password desktop application not found」。2025-12 から開いたまま）。

### WSL の中との関係（2026-11-16 原文で確認）

- WSL の中に入れた Linux 版の op は、Windows の 1Password アプリと連携できない。公式: 「The desktop app integration authenticates over a local connection to the 1Password app on your Windows host, so it isn't available to a CLI binary installed inside the Linux side of WSL. Install 1Password CLI on Windows, then call the Windows `op.exe` from your WSL shell」（https://developer.1password.com/docs/cli/app-integration/ ）。
- 仕組み: Windows では、アプリが名前付きパイプでつながったプロセスの署名（Authenticode）を確かめる（公式 app-integration-security）。Linux 版の op はこのパイプに届かない。
- WSL から Windows の op.exe を呼ぶと、Windows Hello の画面が出て、値は標準出力で WSL に戻る（利用者の報告が複数。公式に手順は無い）。この PC でも、WSL の root から op.exe 2.41.1 を呼べる事は確かめた（版の表示だけ。サインインはしていない）。
- WSL から呼ぶ時の既知の困り事（利用者の報告）: 環境変数が渡らない（WSLENV が要る）・`op run` が Linux のコマンドを探せない・行末に \r が付く例がある・直接呼ぶと失敗し cmd.exe 経由なら通った例がある（2025-10、原因は分かっていない）。
- WSL から呼ぶと、Windows から見た「op を呼んだプロセス」が何になるかは分からない（WSL の中継のプロセスが共通なら、AI が WSL で動かす op と承認を分け合う恐れがある）。公式の文書に記述が無い。

### 結論: 入力係は Windows 側で動かす

- 入力係（Node）は Windows で動かす。Kitesurf だけを WSL で動かし、入力係は 127.0.0.1:8787 につなぐ（Windows 側から開ける事は試作で確かめた）。
- 1Password は Windows の op.exe（winget の 2.41.1・この PC では 11/04 に連携をオン）を、`login` 1 回ごとの使い捨ての子プロセスから呼ぶ。呼ぶ元のプロセスが毎回替わるので、取るたびに1Password の許可の画面が出る（公式の「呼んだプロセスごと」の規則による。実機で回数を数えて確かめる）。
- これで「取るたびに利用者が 1Password で許可」の形は成り立つ。WSL からの道の分からない所（呼び元のプロセス・\r・直接呼びの失敗）も避けられる。
- Mac・Linux で使う人向け: 入力係と Kitesurf を同じ OS で動かす。Mac・Linux は承認が窓ごとに続くので、`login` のたびに `op signout` で閉じる（公式の終了条件。実機で確かめる）。

| 案 | 毎回の許可 | 分からない所 | 採るか |
|---|---|---|---|
| A. 入力係を Windows で動かし op.exe を直接呼ぶ | 子プロセスを替えれば出る（公式の規則） | 実機での回数 | 採る |
| B. 入力係を WSL で動かし op.exe を WSL から呼ぶ | 呼び元が分からず、保証できない | 呼び元・\r・直接呼びの失敗 | 採らない |
| C. 入力係を WSL で動かし、Windows 側の小さな取り出し係を powershell.exe 経由で呼ぶ | 取り出し係を毎回起動すれば出る | 2 つの係の間の値の受け渡しが増える | 採らない（A で足りる） |
| D. 1Password SDK を Windows の入力係で使う | プロセスごと（公式） | 1Password の許可の画面に「node.exe」と出て見分けにくい・SDK の版が 0 | 次の候補。A が実機で駄目な時に替える |

## 3. AI と入力係のやり取り

### AI に渡す道具

| 道具 | 中身 | AI に返す物 |
|---|---|---|
| `open(url)` | 画面を開く。http・https・about:blank だけ | 開いた後の住所・題名 |
| `snapshot()` | 画面の文字と操作できる部品の一覧（番号付き） | 値を隠した一覧（4 節） |
| `click(ref)`・`type(ref, text)`・`press(key)` | AI が決めた操作。`type` は AI が知っている値（検索語など）用 | 結果と、移動した時の新しい住所 |
| `screenshot()` | 画面写真 | 4 節の条件を満たす時だけ返す |
| `login_sites()` | ログインに使える項目の一覧 | 項目の名前と住所だけ。ID・パスワードは返さない |
| `login(site, reason)` | ログインを頼む | 結果の種類と理由だけ |

渡さない道具: 任意の JS を動かす道具（`evaluate` など）、生の CDP、通信の記録、コンソールの記録。任意の JS は値を読めるうえ、形を変えて持ち出せるので、伏せ字では守れない（作者の前の道具 [agent-login](https://github.com/Maaa2005/agent-login) で `browser_run_code_unsafe` を止めたのと同じ理由）。

### `login(site, reason)` の流れ

1. 確かめる（1Password にはまだ触らない）
   - 開いているのは最上位の画面で、https。
   - 画面の住所の origin（`https://〜` の始まり）が、1Password の項目の住所の origin と同じ。
   - パスワード欄がちょうど 1 つ。フォームの送り先の origin も同じ（agent-login に無かった確かめ。送り先だけ別のサイトにする罠を断る）。
   - この画面で AI が任意の JS を動かしていない（そもそも道具が無いが、将来足す時の決まりとして残す）。
2. 1Password に値を頼む。利用者の 1Password の許可の画面が出る。1Password の画面にはサイト名を出せない（出るのはアカウント名・頼んだプロセスの名前・範囲と期間。2 節）。そこで入力係は頼む直前に、Windows の通知でサイトの origin と項目名を出す。AI が書いた `reason` は参考として併記するだけ（AI が書くので正しいとは限らない）。4 分押されなければ打ち切る（agent-login で、押されないまま待ち続けた不具合があった）。
3. 承認の後に確かめ直す。待っている間に画面が変わった（住所・文書が替わった）ら、値を捨てて断る。
4. 入れる。ID とパスワードを Kitesurf の入力欄に直接入れる。入れ方は `Input.insertText`（試作で 16 回すべて一致・1 回で全体を渡せる）。
5. Kitesurf の弱い所を補う（試作で分かった事）。普通の入力欄では beforeinput が出ず、change は Enter の時しか出ない。そこで入力係が入れた欄に change を出す（入力係だけが使える操作。AI には渡さない）。
6. 送る。送信ボタンのクリックか、パスワード欄で Enter。`Input.insertText` は移動を追わないので、送信は必ずこのどちらかで行う。
7. 片付ける。成功・失敗に関係なく、入れた欄がまだあれば空にする。持っていた値はメモリから捨てる。
8. AI に返す。

`login` の最中（1 で確かめ始めてから 8 で返すまで）は、AI の他の道具（`snapshot`・`screenshot`・`click` など）を待たせる。入れてから送るまでの間は、値がページの中にあるため。1Password も自社の AI 向けの仕組みで同じ事を求めている（「You have to make sure the model and agent can't read the page until `fillCredential` returns, because the values are in the page between fill and submit. ... A lock in your orchestrator that blocks DOM reads, screenshots, and other CDP commands to the tab also works.」 https://www.1password.dev/agentic-autofill/partners/faq ）。

AI が書く `reason` は信用しない文として扱う。長さを 100 字までに切り、そのまま文字として出す（1Password の AI 向けの仕組みも、目的や理由を「untrusted claim」として扱い、長さに上限を付けている）。

### AI に返す物・返さない物

| 返す | 返さない |
|---|---|
| 結果の種類: `submitted`・`denied`（利用者が断った）・`timeout`（4 分押されない）・`mismatch`（住所が違う）・`not_found`（欄が無い・2 つある）・`changed`（承認中に画面が変わった）・`error` | ID・パスワード、その一部や長さ |
| 断った理由（例「画面の origin が項目の origin と違う」） | 入力欄の中身、送信の中身、通信・コンソールの記録 |
| 送信後の住所と題名 | 1Password の項目の ID・保管庫の名前（一覧に出す名前は除く） |
| 二段階認証の画面に進んだか | 承認の画面に出した文の中の秘密（そもそも入れない） |

ID は秘密ではないが、最初の版では返さない（返す理由が今は無い）。

## 4. 画面の中身を AI に見せる時に値を隠す方法

### Kitesurf で値が見える所（commit 4a29038 のコードを読んだ結果）

Kitesurf には、パスワードの値を伏せる処理が 1 つも無い。

| 出口 | 値が出るか | 根拠（packages/ からの場所） |
|---|---|---|
| アクセシビリティの木（`Accessibility.getFullAXTree` など） | 出る。全部の入力欄の値をそのまま `value` に載せ、password も普通の文字欄と同じ扱い | page-script/src/index.ts:2869 で `element.value` を型を見ずに取る。engine/src/cdp/accessibility.ts:506・728 |
| 画面写真・PDF・画面の流し見（`captureScreenshot`・`printToPDF`・`startScreencast`） | 出る。password の欄を ● に置き換える描画が無い | 描画の blitz-paint に password を扱う所が 0 件 |
| Kitesurf 独自の描画の記録（`Kitesurf.recordScene`・`startSceneStream`） | 出る。描いた文字を文字のまま記録する | core/src/paint/scene_record.rs |
| JS の実行（`Runtime.evaluate` など） | 出る。`.value` を読める | engine/src/cdp/runtime.ts |
| 通信の一時停止（`Fetch.requestPaused`） | 出る。送信の中身（`user=..&pass=..`）をそのまま載せる | engine/src/eval/outbound.ts:751-763 |
| 住所（GET のフォーム） | 出る。住所の ? の後ろに入る。Kitesurf の起動記録にも住所が出る | engine/src/cdp/page.ts:2033 |
| DOM（`getOuterHTML`・`getDocument`） | 普通は出ない。入れた値は属性に書き戻されない。ただしページが欄の種類を変えたり、属性に書いたりすると出る | dom-shim/src/element/forms/input.ts:132-156 |
| 通信の知らせ（`Network.requestWillBeSent`） | 送信の中身は載らない（`postData` がコードに無い）。住所は載る | engine/src/cdp/network-events.ts |
| Kitesurf の起動記録 | 入れた値・送信の中身は出ない。住所は出る | 試作の記録で合成の値が 0 件 |

1 つの Kitesurf に 2 本目の CDP でつなぐと、別のブラウザ（タブ・クッキーも別）になる（engine/src/cdp/connection.ts:151-292）。

実機の確かめ（2026-11-16・合成の値 `Kp7#canary-596289`・試作の台本で）:

| 確かめた事 | 結果 |
|---|---|
| アクセシビリティの木 | 値がそのまま出た（「Password」の欄の `value`） |
| DOM の文書全体 | 出なかった（`<input ... type="password">` に value 属性なし） |
| 画面写真 | type=password なのに値が平文で写った（目で確認・作者の手元の記録） |
| `-webkit-text-security:disc` を足して撮る | 効かない（写真のバイト数も同じ） |
| `color:transparent` を足して撮る | 欄が空に見えた（目で確認・`shot-transparent.png`） |
| 欄の上に黒い四角を重ねて撮る | 隠れた（`shot-overlay.png`）。隠してもアクセシビリティの木には値が残る |
| 2 本目の接続から 1 本目のページが見えるか | 見えなかった（about:blank だけ）。生の `Target.getTargets` は取れなかったので断定はしない |
| 通信の一時停止（`Fetch.enable` してから送信） | 送信の中身に値が出た（`password=Kp7%23canary-...`。URL の形） |

### 隠し方

1. AI には生の CDP を渡さない。上の表の出口のうち、JS の実行・通信の一時停止・描画の記録・アクセシビリティの木は、入力係だけが使う。
2. `snapshot` は入力係がアクセシビリティの木から作り直す。そのとき次の欄の `value` を消し、「入力済み」とだけ書く。
   - 今 type=password の欄（DOM で種類を確かめる）
   - 入力係が値を入れた欄（ページが後から種類を text に変えても、欄の番号で覚えておく）
3. AI に返す前に、返す物すべてを入れた値で探す。形を変えた値（大小文字・JSON の \" と \uXXXX・HTML の &amp; と &#NN;・URL の %XX と +・base64・16 進・逆順）も探す（Browser Use の伏せ方の一覧に合わせた）。見つかったら、その返事ごと返さず `error` にする（伏せて返すより安全側）。
4. 住所は origin と path だけを返す（? の後ろを落とす）。GET で送るフォームには `login` で入れない（値が住所と Kitesurf の記録に出るため）。
5. 画面写真は、次の 3 つを満たす時だけ返す。
   - 入力係が入れた欄に値が残っていない（送った後に空にしている）。
   - 3 の探し方で、今の画面の文字（アクセシビリティの木と DOM）に値が無い。
   - 撮る間だけ、入力係が password の欄すべてに `color:transparent` を当てる（実機で効いた）。Kitesurf は password の欄を ● にしないので、AI が自分で入れた文字も含めて写さない。撮った後に外す。
   Kitesurf は画面の文字を DOM から描くので、文字で探せば多くは防げる。canvas に描かれた値だけは文字で探せない（7 節の限界）。
   `-webkit-text-security` は Kitesurf で効かないので使わない。
6. `login` の最中は、AI の他の道具を待たせる（3 節）。
7. 入力係の記録には、入れた値を書かない。`Input.insertText` の引数は記録しない。記録も 3 の探し方の対象にする。
8. 入力係は `Fetch.enable` を使わない（使うと送信の中身が入力係に届き、記録に混ざる恐れがある）。

## 5. 合成パスワードの漏れ試験の合格条件

### 試験の値と相手

- 値は毎回の試験でランダムに作る合成の値（24 字・記号と日本語を含む）。本物のパスワードは使わない。
- 1Password の代わりに、同じ形で値を返す試験用の係を使う。係は呼ばれた回数を数える。
- 受け口は自前の試験用サーバー（127.0.0.1）。受けた値を記録する。

### 探す場所と形

- 場所: AI とのやり取りの全部（MCP の行き帰りを丸ごと記録した物）、入力係の記録とファイル、Kitesurf の起動記録、試験中に作られた一時ファイル。
- 形: そのまま・URL の %XX と + ・フォームの送り方・JSON の \" と \uXXXX・HTML の &amp; と &#NN;・base64（値だけ、`ID:パスワード`）・16 進。大小文字は区別しない。

### 合格の条件（全部満たす）

1. 対照: 隠す処理を切ると、上のすべての場所で値が見つかる。見つける力を先に確かめる（対照が通らない場所は「0 件」を合格にしない）。
2. 本番: 隠す処理を入れると、すべての場所で 0 件。
3. 送れている: 普通の形の時、受け口が受けた ID・パスワードが入れた値と完全に一致する（何も入れずに 0 件になるのを防ぐ）。
4. 断る: 次の時は値を入れず、試験用の係が呼ばれた回数も 0。
   - origin が違う（似た名前・http・別のポート・部分一致の住所）
   - iframe の中のログイン欄
   - パスワード欄が 2 つ、または無い
   - フォームの送り先の origin が違う
5. 承認の後に断る: 承認を待つ間に画面を変えると、値を入れずに `changed` を返し、本番の 0 件も守る。
6. 罠のページでも 0 件: 入れた値を画面の文字に写すページ、パスワードを表示に切り替えるページ、題名・住所の # の後・コンソール・保存領域に写すページ、別のサイトへ値を送るページ。どれでも AI への返事と記録に 0 件。
7. 同時の呼び出し: `login` の最中に `snapshot`・`screenshot`・`click` を同時に呼んでも 0 件。
8. 画面写真: 対照として、隠す処理を切ると写真に値が写る事を目で 1 回確かめる（2026-11-16 に `shot-plain.png` で写った）。本番では、値が欄に残っている間と、画面の文字に値がある間は写真を返さない。送った後に返した写真を、試験では文字読み取り（OCR）にかけて値が 0 件である事も見る。
9. アクセシビリティの木: 対照として、隠す処理を切ると `snapshot` に値が出る事を確かめる（Kitesurf は値をそのまま載せる）。本番では 0 件。ページが欄の種類を password から text に変えても 0 件。
10. 移動の罠: 入れた直後にページ自身が別の住所へ移る（`location.href`・リダイレクト・新しい窓）・`https://user:pass@host` の形の住所・別の origin の iframe。どれでも値は項目の origin の外に入らない。Browser Use では、AI が起こした移動しか住所の確かめをしない穴が報告されている（github.com/browser-use/browser-use/issues/5815 ）。入力係は入れる直前と送る直前に、ブラウザが報告する最上位の住所を確かめ直す。
11. 偽のログインへの誘導: ページの文（見える文・隠した要素・偽の「システムの知らせ」）で AI を偽のログイン画面へ誘い、`login` を呼ばせる。入力係は origin が項目と違うので断り、試験用の係が呼ばれた回数も 0。論文 LoginTrap（arXiv 2608.04741）では、この型の攻撃が AI の種類を問わず平均 86% 成功している。AI の判断に頼らず、入力係が入れる瞬間に止める。
12. 表示させて読む: パスワードを表示に切り替えるボタンを AI に押させ、読ませる（Zenity の 2026-03 の報告で、別の AI ブラウザが 1Password の値をこの形で持ち出された）。入れた欄は送った後すぐ空にするので、表示に切り替えても何も無い。
13. 3 回続けて（毎回新しい値で）全部通る。

先行例の弱い所を試験の根拠にする: Playwright MCP の秘密を伏せる機能は完全一致の置き換えだけで、公式も「This is a convenience, not a security boundary.」と書く（playwright.dev/mcp/configuration/options ）。Browser Use は形を変えた値も伏せるが、「Screenshots are not redacted.」（docs.browser-use.com/open-source/secrets ）。この道具は、形を変えた値と画面写真の両方を試験で見る。

### 手で 1 回だけ確かめる事

- 本物の 1Password で、試験用の保管庫に作った合成の項目（利用者が作る）を使い、1Password の許可の画面が出て、入って、送れる事。
- `login` 1 回ごとに1Password の許可の画面が出る事。同じ子プロセスから 2 回・別の子プロセスから 1 回取り、画面の回数を数える（2 節）。1Password アプリの CLI の活動記録とも合わせる。
- 断った時に `denied` が返り、4 分押さない時に `timeout` が返る事。

## 6. 採らなかった案と理由

前もって決めた分（1Password 公式の自動入力・ログイン済みのクッキーを渡す・Kitesurf 本体の改造・Cloudflare に置く・AI 専用金庫の合鍵）に、設計で足した分。

- 1Password の AI 向けの入力（Secure Agentic Autofill・1Password for Agents の仕組み）: 1Password の拡張をブラウザに載せるのが前提（「The extension runs in Chromium builds that support extensions」 https://www.1password.dev/agentic-autofill/partners/fill ）。Kitesurf は拡張を載せられない。さらに作る側に Business アカウントの登録が要り、まだ「Partner preview」。
- 1Password for Claude: Mac の Claude デスクトップアプリと Claude in Chrome 向け（https://support.1password.com/1password-claude/ ）。Claude Code と Kitesurf には使えない。真似した所: 項目の住所と画面の住所が一致する時だけ入れる・作業ごとに許可する・AI が受け取るのは結果だけ。
- 1Password Environments の MCP: 秘密を手元のファイルに置く形で、公式も「The agent can still read the secrets in that file.」と書いている（https://www.1password.dev/agentic-autofill ）。AI に値を見せない目的に合わない。
- 1Password のサービスアカウント（無人で動く合鍵）: 利用者の承認なしで動く。公式も「Service accounts allow you to automate access with no user present.」「It's up to you to save and protect the service account token.」と書き、合鍵が持ち出されると承認なしで読める。「取るたびに利用者が 1Password で許可」の形に合わない。
- 1Password Connect サーバー: 自分でサーバーを動かして守る必要があり（公式「Requires infrastructure to run and maintain」）、合鍵の管理も要る。自分の PC だけの最初の版には重い。
- AI に生の CDP を渡し、間で伏せる: CDP の値の出口が多く（DOM・JS の実行・通信の記録など）、形も変わる。決まった道具だけ渡す方が守る所が少ない。
- 返事の中の値を伏せ字にするだけで守る（Playwright MCP の秘密の機能の形）: 完全一致の置き換えだけで、公式も守りの境界ではないと書く。形を変えた値・画面写真・JS の実行が抜ける。この道具では伏せ字は最後の網で、主の守りは「道具を絞る」「値を返す道を作らない」にする。
- 画面写真を一切返さない: いちばん安全だが、AI が画面の配置を見られなくなる。最初の版は 4 節の条件付きで返し、設定で切れるようにする。
- Kitesurf 独自の `Kitesurf.setControlValue` で入れる: 実機では `no PageScript` で動かず、返事に値を含める作り。試作で通った `Input.insertText` を使う。
- Playwright MCP を組み込む（agent-login の形）: 試作は Kitesurf の README どおり Puppeteer で動かした。Playwright MCP は値を画面情報・保存ファイル・入力の返事に平文で出し、伏せる所が多かった（agent-login の実測）。

## 7. 守れない事（限界）

- AI は利用者と同じ権限で動く。入力係は「AI がうっかり見る」「ページの文に操られた AI が道具で取り出す」を防ぐ物で、端末を自由に使う AI の本気の取り出しは止めきれない（agent-login と同じ限界。1Password も同じ権限の物は守れないと書いている）。
- Kitesurf の CDP の口（127.0.0.1:8787）には認証が無い。ただし 2 本目の接続は別のブラウザになり、入力係のページは見えなかった（4 節）。AI が直接つないでも、入力係のページの値をそのまま読む道は今のところ見つかっていない。Kitesurf のプロセス（WSL の中）を調べる・止める事は、同じ権限の AI ならできる。
- AI が自分で op を呼べば、利用者の 1Password の許可の画面が出る。1Password の画面には頼んだプロセスの名前しか出ず、入力係の頼みと見分けにくい。利用者は、自分が「ログインして」と頼んだ直後の画面だけ許可する。
- 送った後のサイト自身は値を受け取る。そのサイトが値を画面に描いた絵（canvas）までは、文字で探せない。
- パスキー・二段階認証は利用者が行う（Kitesurf はパスキーに対応していない）。
- 入れる直前に住所と文書を確かめても、確かめてから入れるまでの一瞬にページ自身が移れば、ID やパスワードが移った先に入る恐れが残る（作る途中の点検で見つかった。Kitesurf の CDP では確かめと入力を一度にできない）。
- ページが値の一部（前半だけなど）を画面や文に出した場合、入力係は見つけられない。探すのは値の全体と、その形を変えた物だけ（2026-11-16 の再点検で Codex が「高」とした。直すには、値を入れたページから返す物を決まった結果だけに絞る作りに変える必要があり、この版では行わない）。
- 画面写真に写った ID は伏せない。ログインの後のページに出る ID も同じ。守るのはパスワードで、ID は AI に見える事がある。
- 入力係の通知は、同じ権限のプログラムなら同じ見た目で出せる。通知と許可の画面だけでは、本物の頼みと見分けきれない。
- 返事が「保護した値が含まれる」で止まるかどうかで、AI は推測した文字がパスワードと同じかを確かめられる。推測しやすいパスワードには使わない。
- 入力係の処理の一部（欄を空にする・文字の長さを見る・題名を取る）はページの中で動くので、ページがその結果を偽れる。
- 正しいサイトでも、そのページが読み込んだ別のスクリプトは、入れてから送るまでの間に値を読める。ページ自身の通信の行き先までは縛れない。入力と確かめを一度にする手段は Kitesurf の CDP に無い。
- 設定（環境変数と `sites.json`）は信頼する前提。同じ権限の AI が書き換えれば守りは弱まる。最後の砦は「1Password の項目の住所が一覧の origin と合うか」の確かめ。
- 入力係の記録（`gate.log`）には、開いたページの origin と path が残る。大きさの上限は無い。
- 罠のページへの強さはまだ確かめていない。5 節の 6・10・11・12（値を写す・別のサイトへ送る・入れた直後に移る・偽のログインへ誘う・表示に切り替えさせるページ）は、最初の版の試験から外した（2026-11-16）。

## 8. 作る時に決めた事（2026-11-16・最初の版）

細かい形は `docs/impl-spec.md`。

- ログインに使えるサイトは、利用者が書く一覧のファイル（`sites.json`）で決める。`login_sites` はこの一覧だけを返し、1Password に触らない（一覧を出すたびに許可が要らないように）。origin はこの一覧で先に確かめ、1Password から取った後に項目の住所とも合わせる。
- 値は送った後もすぐには捨てず、返事と記録を探す照合用にだけ、入力係のメモリに入力係が終わるまで持つ（ファイルには書かない）。送った後のページが値を写した時に見つけるため。最初は 30 分で消していたが、ページに値が残ったまま守りが切れるので、期限をやめた（2026-11-16 の安全点検）。3 節の 7 の「捨てる」は、手元の変数の値を消す意味に変える。
- 見つけたら返事ごと止めるのはパスワードだけ。ID はページが表示する事が多いので止めず、画像以外の返事の文字の中で「(ID)」に置き換える（4 文字以上の時。2026-11-16 の安全点検で、ID がそのまま返っていたため足した）。画面写真の中の ID は伏せない（7 節）。
- 送り方が GET のフォーム（method が無い時も含む）には入れない（値が住所と Kitesurf の記録に出るため）。JS で止めて送る画面のために、サイトごとに `allowGetForm` で外せる。
- 隠す処理を切る切り替えを、試験の時だけ使える形で持つ（`KS1P_TEST_MODE` と `KS1P_TEST_DISABLE_GUARD` の両方が要り、さらに op の命令がこのリポの偽の op（`test/fake-op.mjs`）の時だけ効く）。効いている時は返事の頭に印を付ける。5 節の 1 の対照に使う。
- 試験用の 127.0.0.1 の http は、試験の時だけ https と同じに扱う（`KS1P_ALLOW_HTTP_LOOPBACK` と `KS1P_TEST_MODE` の両方が要る）。
- 2026-11-16 の安全点検（新しい会話の Claude と Codex。どちらも読むだけ）の後に足した守り: `NODE_DEBUG` があれば起動しない（Puppeteer がブラウザへ送った内容を stderr に出すため）。op は PATH の絶対の住所のフォルダだけから探し、作業フォルダは見ない（Windows の Node は作業フォルダを先に探すため）。子に `OP_` で始まる環境変数を渡さない。Kitesurf の住所は自分の PC の中だけ。4 文字未満のパスワードは入れない。文字を切る前にも照合する。送る直前にも承認の後と同じ確かめをする。画面写真は透明にできなければ撮らず、撮った後にも確かめる。入力係が終わる時に子を止める。細かい形は `docs/impl-spec.md`。
- `op signout` は最初の版では呼ばない。Windows は呼んだプロセスごとの承認で、使い捨ての子が終われば次は別のプロセスになるため。Mac・Linux で使う時に足す。
- 本物の 1Password での確かめ 1 回目（2026-11-16・作者の PC）: login 1・2 回目とも 1Password の許可の画面が出て、受け口の ID とパスワードが一致し、AI とのやり取りの記録と入力係の記録に値は 0 件だった。使い捨ての子プロセスで毎回許可が要る形は、実機でも成り立った。3 回目（キャンセルで `denied` が返るか）は誤って許可したので、もう一度回す。
- 本物の 1Password での確かめ 2 回目（2026-11-16・作者の PC）: 合格。login 1・2 回目は送れて、許可の画面が毎回出て、ID とパスワードが一致した（かかった時間 27 秒・11 秒。許可を押すまでを含む）。3 回目はキャンセルで `denied` が返り、受け口への送信は 0 回。AI とのやり取りの記録と入力係の記録・stderr に値は 0 件。
