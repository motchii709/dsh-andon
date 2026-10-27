# dsh-andon — 設計契約

このファイルは実装者向けの凍結済み契約。色・寸法・JSON形状はここが唯一の正。
変更する場合は必ずこのファイルを先に直す。

---

## 0. 何を作るのか

DSH (DeepSeek Harness) の稼働状態を、**別のタブレット / 別タブに常時表示しておく**ための2画面。

| 画面 | URL | 用途 | 見る距離 |
|---|---|---|---|
| アンドン | `/andon` | 止まっていないか。人間が対応すべきことは何か | 2〜3 m |
| カンバン | `/kanban` | DSH が今なにをしているか。作業の流れ | 50〜80 cm |

どちらも **読み取り専用**。操作は「見る」「絞り込む」「クリックして詳細を開く」だけ。

### やらないこと
- DSH のチャット UI の中に埋め込む（→ DSH の SPA にはページ内ルーターが無く、`main` スロットを奪うと自分が使いにくくなるだけ）
- 認証・書き込み・ジョブ投入
- npm 依存。**Node標準モジュール以外を一切使わない。** ビルド工程も無し。

---

## 1. デザインリード（実装前に読む）

> **Industrial control panel.** 個人のAIハーネスを1人が見張るための工場アンドン盤。
> 2〜3 m 先の据置タブレット、常時点灯。フォントはOS標準、**画面内で色を持つのはランプだけ**。

### 三つのダイヤル
| | 値 | 理由 |
|---|---|---|
| DESIGN_VARIANCE | 3 | 制御盤。配置は予測可能でなければならない。奇抜さは「読めなさ」に直結する |
| MOTION_INTENSITY | 2 | 常時表示。動きは「生きている」ことの証明だけ。点滅・流れる文字・バウンスは禁止 |
| VISUAL_DENSITY | 6 | 一覧性が正義。ただしカードの入れ子は禁止 |

### 絶対にやらない（AIスロップの典型）
- 紫/青のグラデーション、ネオンのグロー、メッシュ背景
- `Inter` + `slate-900` のデフォルト組
- グラスモーフィズム（`backdrop-filter` ぼかし）の多用
- 均等3カラムのフィーチャーカード
- 絵文字のUI使用
- 意味のない装飾SVG、占位用の箱、`Lorem ipsum`
- 角丸の不統一（丸ボタンと角カードの混在）
- カードの中にカード
- 画面を埋めるためのダミー数値。**データが無いときは「無い」と表示する**

---

## 2. デザイントークン（`public/tokens.css` が実装）

色は**無彩色（graphite）＋ 意味色3つだけ**。第4のアクセント色を足さない。ただし**意味色の使い方は2枚で違う**。

```
背景   #0c0e10   パネル #14181b   パネル2 #1a1f23   パネル3 #0f1214
罫線   #242a2f   罫線(弱) #1d2327
文字   #e9edf0 (主) / #bcc5cc (副) / #8b979f (三次) / #6e7a83 (無効・装飾のみ)
正常   #34c26b   注意  #e8a13a   要対応 #e5484d   消灯 #2f363c
```

- **アンドンは盤面全体が意味色になる。** 暗い地に小さな色付きランプを並べるのはダッシュボードであってアンドンではない。3m先から読ませるには、色そのものが面積を持たなければならない。§3.1参照。
- **カンバンはダーク固定**で、色は文字色ではなくセル・チップ・ランプの地にだけ使う。近距離で読む盤なので暗色1本に絞るほうが破綻しない。
- アンドンのフィールド文字は**黒系**（`#07130c` / `#191002` / `#1c0507`）。飽和した地の上では白より黒の方がコントラストが高い。
- **角丸は4pxで統一**（`--r`）。円はランプだけ（アンドンにはランプを置かない）。
- 数字は `font-variant-numeric: tabular-nums`。桁が動いても幅が変わらないこと。
- 影は背景色に寄せた黒。純黒のドロップシャドウを明るい面に落とさない。

### 書体
```css
--font-ui:  "Yu Gothic UI", "Yu Gothic", "Meiryo", "Hiragino Kaku Gothic ProN",
            "Noto Sans JP", system-ui, sans-serif;
--font-num: "Bahnschrift", "DIN Alternate", "Roboto Condensed", "Yu Gothic UI",
            system-ui, sans-serif;   /* DIN系＝工業計器。Windows 10+ に同梱 */
```
Google Fonts を `@import` しない（LAN内・オフラインで動く必要がある）。

### サイズは `clamp()` で画面に追従させる
タブレットの解像度が不明なので、固定pxで組まない。以下は実装値。
```
アンドン 状態語        clamp(76px, 11.5vw, 236px)
アンドン 件数          clamp(96px, 14vw, 300px)
アンドン 工程の値      clamp(30px, 3vw, 62px)
アンドン チッカー      clamp(16px, 1.75vw, 36px)
カンバン 総合状態見出し clamp(40px, 6.5vw, 92px)
カンバン 計器の数値    clamp(22px, 2vw, 38px)
本文                  clamp(13px, 1.15vw, 16px)
```
アンドンの下限が大きいのは、3m先から読める大きさを下回らせないため（§3.1の視認性の目安）。

---

## 3. レイアウト

### 3.1 画面の構成（2026-10-27 改訂）

盤は3つの帯でできている。**状態の言葉は4つだけ**: 正常 / 権限 / 質問 / 停止。

```
┌────────────┬──────────────────────────────────────┐
| レール      | 色面                                  |
| 要対応 1    |  停止                    1件            |
| 作業中 4    |  承認待ち 6分放置 1件                   |
| 記憶 69%    |  ● セッション名        理由  23:50から  |
| 異常 0      |  ● …（動いているセッション全部）        |
|            |                        LIVE 04:23:06   |
└────────────┴──────────────────────────────────────┘
```

### 状態の言葉（サーバの `label` が正）

| 語 | いつ | 色 | 意味 |
|---|---|---|---|
| **正常** | running / idle | 緑 | 何もしなくていい |
| **権限** | 承認待ち | 黄 | 承認すれば進む |
| **質問** | 入力待ち | 黄 | 答えると進む |
| **停止** | error / stopped / 文脈超過 | 赤 | 壊れた。人が直す |

- 質問も黄。どちらも「人の返事が要る待ち」で、色を分けると優先順位を読み手に考えさせる。
- 判定（`overall`: normal/watch/needs-you/alarm）とは**別軸**。盤は「人が何をすべきか」だけを言う。
- `watch`（無反応5分・文脈80%）は**語を持たない**。正常に丸め、数字と理由だけ残す。
- 判定は `lib/state.js` の1箇所。クライアントは `label` をそのまま使う（古いサーバ向けに
  `withLabels()` で同じ規則を1回だけ補完する）。

### 色面

- 主役は**状態語**（大きく）、右上に**人が動くべき件数**。
- その下に**動いているセッション全部**（停止→権限→質問→正常の順、8件まで、残りは「他n件」）。
  - 名前 34文字で切り、待ち/停止は理由（22文字）と「いつから」を添える。
  - 「いつから」は 3分未満=地味 / 3分以上=橙 / 10分超=赤の文字色。**面は塗らない**。
  - 正常の行は灰色・細字で沈める（正常は静かに）。
- 右下に `LIVE` と時計。**チッカー（直近ログ3件）は廃止**した。生存表示だけは必ず残す
  （消すと「止まっているのか壊れているのか」が分からなくなる）。
- 点は面の色に沈むので白い輪郭を付ける。停止は「白い輪 + 太い赤」で色に依らず形でも分かる。

### レール

- 4局（要対応 / 作業中 / 異常 / 診断不能）。8局あったが、常時0で何も起きない数字は落とした。
- **記憶（context %）は出さない**（2026-10-27）。数字が意味を持つのは「逼迫している」
  ときだけで、そのときはセッション行の理由に `コンテキスト 92%` として出る。
- **異常と診断不能は別局**。「壊れた（直す）」と「読めなかった（見に行く）」は
  人がやることが違う。診断不能は赤にしない（盤が「壊れた」と嘘をつく）。
- 値は3段で読ませる: 呼んでいる（色のセル）> 動いている（黒・太字）> 空（灰 .58・細字）。
- **点灯セルの地に `color-mix()` を書かない**（Chrome 95 で宣言ごと落ち、点灯が消える）。

### 時計

- **左上の帯（`field-tag`）に置く**。盤を見た瞬間に知りたいのは時刻で、
  それは状態語と並ぶ位置にあるべき。右下の `LIVE` の隣に小さく置いていたときは 3m から読めなかった。
- `tabular-nums` で桁を固定する（秒が動くたびに幅が変わると目障り）。

### 盤に出さないもの

- **idle のセッション**。DSH の `sessions[]` は閉じたセッションも残る全履歴なので、
  そのまま並べると 7時間前の会話が緑で並び、48時間前の文脈190%が赤で鳴り続ける。
  盤は「いま動いているか」を見るもの。履歴は DSH 本体で見る。
- ただし**承認待ち・入力待ちは idle でも出す**。出さないと誰も取らない承認が盤から消える。
### レイアウトの約束

- 色面が上（横並びでは右）、レールが下（横並びでは左）。grid の位置は `md3ex.css` で明示する
  （自動配置任せにするとレールが1行目に来て色面が潰れる）。
- `#board` に `height` を書かない。4辺 0 で箱を決める（`100vh`/`dvh` は実機で3回外した）。


## 4. 日本語コピー規則

- ラベルは体言止め・短く。「〜を実行中のもの」ではなく「実行中」。
- 空状態: 「対応が必要なものはありません」「いま動いているものはありません」。
- 接続エラー: 「DSH に接続できません」「最終更新 12:30:05」。
- **感嘆符・絵文字・「〜してみましょう」調は使わない。** 制御盤は淡々と事実を出す。
- 数字と単位の間に空白を入れない（`3件`、`42%`）。英数字と日本語の間には入れない（`DSH に接続`は例外で半角スペース可）。

---

## 5. サーバー契約

### ルート（DSH ホスト 3080 と LAN リスナーの両方で同一）

| メソッド | パス | 返すもの |
|---|---|---|
| GET | `/andon` | `/andon/` へ 302 |
| GET | `/andon/` | `andon.html` |
| GET | `/kanban` | `/kanban/` へ 302（互換のため残置。主役ではない） |
| GET | `/kanban/` | `kanban.html`（同上） |
| GET | `/<盤>/assets/<file>` | `public/<file>`（`tokens.css` `md3ex.css` `board.js` `andon.js` `kanban.js` のみ） |
| GET | `/api/andon/state` | 下記 JSON。`cache-control: no-store` |
| GET | `/api/andon/health` | `{"ok":true,"uptimeSec":n}` |
| GET | `/` (LANリスナーのみ) | `/andon/` へ 302 |

- ルートは**完全一致のみ**（前方一致を張らない）。`/andon` を末尾スラッシュへ302するのは、ページ内の相対アセット参照（`./assets/…`）を成り立たせるため。
- 静的アセットは**許可リスト方式**。パストラバーサルを絶対に許さない。
- Content-Type を明示。`X-Content-Type-Options: nosniff` を付ける。
- HTML も JS も CSS も `charset=utf-8`。

### `GET /api/andon/state` の JSON

```jsonc
{
  "schema": 1,
  "generatedAt": 1760000000000,      // epoch ms
  "status": "ok" | "warn" | "alert", // 総合状態
  "host": { "pid": 1234, "uptimeSec": 3600, "node": "24.18.1", "platform": "win32" },
  "counts": {
    "liveSessions": 3, "agentsRunning": 1, "agentsIdle": 2,
    "jobsRunning": 1, "jobsFailed": 0, "subagentsRunning": 0,
    "pendingApprovals": 1, "pendingQuestions": 0,
    "goalsActive": 2, "goalsBlocked": 0, "goalsPaused": 0,
    "sessionsTotal": 412
  },
  "stations": [                       // 必ず8件・固定順
    { "id": "needs-you", "label": "要対応", "value": 1, "suffix": "",
      "hint": "承認 1", "severity": "alert" }
  ],
  "alerts": [                         // 要対応リスト。severity desc, since asc
    { "id": "approval:abc", "kind": "approval" | "question" | "goal" | "job" | "team" | "error",
      "severity": "alert" | "warn",
      "title": "承認待ち: bash",
      "detail": "任意。1行に収まる長さに切り詰める",
      "sessionId": "016d...", "sessionTitle": "…",
      "since": 1760000000000 }
  ],
  "cards": [                          // カンバン用
    { "id": "session:016d...", "column": "alert" | "running" | "queued" | "done",
      "kind": "session" | "job" | "task" | "goal",
      "title": "…", "subtitle": "playgrounds / kiosapi agnes-3.0-flash",
      "status": "running", "statusLabel": "実行中",
      "severity": "ok" | "warn" | "alert",
      "since": 1760000000000, "updatedAt": 1760000000000,
      "metrics": [ { "label": "ステップ", "value": "12" } ],
      "progress": { "done": 3, "total": 7 },     // 無ければ null
      "badges": ["サブエージェント"],
      "detail": { "cwd": "C:\\…", "model": "…", "sessionId": "…", "note": "…" } }
  ],
  "activity": [                       // 新しい順、最大40
    { "at": 1760000000000, "severity": "ok" | "warn" | "alert",
      "text": "job-42 完了", "sessionId": "016d..." }
  ],
  "vitals": {
    "profile": "web", "workspace": "playgrounds",
    "model": "kiosapi / agnes-3.0-flash",
    "contextPct": 42, "contextWindow": 131072, "contextTokens": 55000,
    "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
    "hostTotalSessions": 412
  },
  "notes": ["…"]                       // 取得できなかった項目の説明。UIは邪魔しない位置に出す
}
```

**契約の絶対条件**
- すべてのキーが常に存在する。配列は `[]`、数値は `0`。`undefined` を混ぜない。
- 例外で 500 を返さない。取れなかった項目は `0` / `[]` にして `notes` に理由を1行足す。
- 文字列は 200 文字で切る。`\n` は空白に潰す。
- `stations` は**必ず8件、順序固定**。UIは順序を信用してよい。

**数え方の窓（ここが食い違うと盤が壊れて見える）**
- `jobsFailed` は**直近2時間**の `failed` と `killed` の合計。ジョブのアラート（`alerts` の `job`）と `errors` station も同じ2時間の窓を使う。窓が違うと「盤の数字は4なのにキューには2件しかない」という状態が生まれる。
- `sessions` / `running` は現在の同時数（窓なし）。`activity` は直近30分、最大40件。
- `pendingQuestions` は常に `0`（§7参照）。

---

### ハーネス側の契約（`@deepseek-ai/*` の型定義で確認済み）

`lib/state.js` は DSH の内部サービスを読む。**この形は推測できない。** 永続化ファイル（`~/.dsh/storages/session-*.json`）の形と実行時のオブジェクトの形は別物であり、テスト用モックは自分で書く以上いくらでも嘘をつける。実際、存在しない `agent.sessionId` を読んでいたため、実機のカンバンはカード0枚のまま、テストは17件すべて緑だった。形を疑ったら `node_modules/@deepseek-ai/*/lib/types/*.d.ts` を先に読む。

| サービス | メンバー | 契約 |
|---|---|---|
| `ctx.sessions` | `list(): Session[]` | `session.header` は**常にある**。id は `header.id` |
| `ctx.agents` | `list(): Agent[]` | エージェントが駆動するセッションは **`agent.session`**（Session そのもの）。`sessionId` フィールドは無い |
| `ctx.goals` | `get(agent)` | **Agent を渡す** |
| `ctx.agentTeams` | `remoteView(agent): TeamView` | **Agent を渡す**。同期メソッド（`await` しても害は無い） |
| `ctx.subagents` | `listChildren(sessionId, signal?)` | **SessionId 文字列**を渡す。Agent ではない |
| `ctx.sessionProjections` | `stateOf(session, key)` | key は下表の8つだけ |
| `ctx.sessionQuery` | `listSessions(signal?)` | `SessionRecord[]` |
| `ctx.workspaceRegistry` | `list()` | 作業ディレクトリの記録 |
| `ctx.jobs` | `list()` / `onJobsChanged(fn)` | 変化通知は解除関数を返す |

`stateOf` の key は8つ。`SessionProjectionStateMap` は各パッケージが宣言マージで足すため、1ファイルを読んでも全体は見えない。`dsh-agent/lib/types/projection.d.ts` にあるのは `turnBoundary` だけで、残りは別パッケージにある。

| key | 宣言元パッケージ |
|---|---|
| `title` | `dsh-session-title` |
| `todos` | `dsh-tool-todo` |
| `inbox` | `dsh-agent` |
| `goal` | `dsh-goal` |
| `sessionStats` | `dsh-session-stats` |
| `contextPressure` | `dsh-token-meter` |
| `tokenUsage` | `dsh-token-meter` |
| `modelSelection` | `dsh-api-session-controller` |

取れなかった値は `null` や `{}` として静かに流れる。**盤が黙って空になる壊れ方が一番厄介**なので、カードが0枚なのにエージェントが居る場合は、取れたオブジェクトのキー名を `notes` に出す。

## 6. 実装構成

```
dsh-andon/
  package.json
  cordis.patch.yml        # bundle 経由インストール用
  DESIGN.md               # これ
  README.md
  lib/
    index.js              # cordis プラグイン。ルート登録 + LANリスナー + 更新通知
    state.js              # 状態収集。ctx を受け取り上記JSONを返す純粋モジュール
  public/
    tokens.css            # 凍結済みデザイントークン（変更禁止・追記のみ）
    md3ex.css             # M3 Expressive 層（形状・トーン・活字・モーション・
                          #   3デバイスのブレークポイント）+ 末尾に DSH 層
                          #   （色・書体・罫線・角丸）。インライン <style> の後に読む
    board.js              # 共通クライアント（ポーリング・時刻・数値・DOM生成）
    andon.html / andon.js # 本体
    kanban.html / kanban.js  # 主役ではない。/kanban/ はブックマーク互換で残置
  docs/
    andon-desktop.png     # README 用。モックデータで撮るので実データは写らない
    andon-phone.png
  test/
    state.test.mjs        # 偽 ctx で state.js を検証（node標準 assert のみ）
    mock-ctx.mjs          # 偽 ctx フィクスチャ + settle()
  tools/
    preview.mjs           # スタンドアロン確認サーバー（モックデータ・?scenario=）
    shots.mjs             # ヘッドレス Edge で 3ビューポート × 2盤 × 4シナリオを撮る
    phone-harness.html    # 390px 実寸の確認用。iframe は本物のビューポートなので
                          #   headless Edge の最小ウィンドウ幅に騙されない。
                          #   ?base= で実機に向け、?only= で1盤だけ撮る
```

- 資産は**2箇所の許可リストに登録が必要**: `lib/index.js` の明示テーブルと、
  `tools/preview.mjs` の正規表現。片方だけ足すと 404 になり、
  「CSS が効かない」ように見える（実際に `md3ex.css` と `dsh.css` で起きた）。
  いまは `test/state.test.mjs` の「ページが参照する資産に必ずルートがある」検査が
  この取りこぼしを止める。**新しい CSS は新しいルート**なので、走っているホストには
  再起動まで配られない — だから見た目の変更は既にルートのある `md3ex.css` に入れる。
- `tools/preview.mjs` は `lib/state.js` を**起動時に import** する。state.js を変えたら
  プレビューサーバーの再起動が要る。古いモジュールが残ると数字だけ古い、という
  分かりにくい壊れ方をする。

- `lib/state.js` は **HTTP も cordis も知らない**。`createCollector(ctx)` で collector を作り、
  `collector.snapshot()` が上記オブジェクトを返す。`ctx` のメソッドは try/catch で包む。
- `inject` は **`['webServer']` だけ**。状態収集は `ctx.get(...)` 相当の任意参照で行い、
  取れなければ `notes` に落とす。依存を増やすとプラグイン単体で起動できなくなる。
- LAN リスナーは `ctx.effect` で確実に `close()` する。

### ライブ更新
クライアントは `GET /api/andon/state` を **2秒間隔でポーリング**する（アンドン）、カンバンは **3秒**。
SSE は使わない（Cloudflare トンネル経由のバッファリングで壊れる経路があるため）。
サーバーは `cache-control: no-store` を必ず付ける。
