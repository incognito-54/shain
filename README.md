# マルチエージェント基盤

Claude Agent SDK 製の階層型マルチエージェントシステム。

```
あなた(ターミナル)
 └─ オーケストレーター(コミュニケーション層 / Opus)
      │  対話・要件確認・タスク分解・結果統合のみ。重い作業はしない
      │  Agent ツールでワーカーを起動(独立タスクは並列起動)
      ├─ researcher  調査・Web検索・情報収集      (Sonnet)
      ├─ coder       実装・ファイル編集・コマンド実行 (Sonnet)
      ├─ reviewer    検証・レビュー・テスト実行     (Sonnet)
      ├─ operator    ブラウザ操作(Playwright MCP)  (Sonnet)
      └─ writer      文書化・レポート作成          (Sonnet)
```

- **コミュニケーション層**: メインスレッドを `orchestrator` エージェントとして実行。ツールは `Agent / Read / Glob / Grep / TodoWrite` のみに制限し、作業は必ずワーカーに委譲させる
- **作業層**: 各ワーカーは独立したコンテキストで動き、必要なツールだけを持つ。オーケストレーターの1ターン内で複数ワーカーが並列実行される
- セッションは streaming input モードで1本を維持するため、ターンをまたいで文脈が保持される

## セットアップ

```bash
npm install
```

認証は次のいずれか:

| 方法 | 起動コマンド |
|---|---|
| Claude Code のログイン(サブスクリプション) | `npm run start:login` |
| APIキー(`ANTHROPIC_API_KEY` を設定) | `npm start` |

> `npm start` で `Invalid API key` になる場合、シェルに古い `ANTHROPIC_API_KEY` が export されています。`npm run start:login` を使うか、キーを更新してください。

## 使い方

```bash
npm run start:login
```

```
あなた> ○○のライブラリを調査して比較表を作り、サンプル実装まで作って
```

オーケストレーターがタスクを分解し、`▶ ワーカー起動 [researcher] ...` のようにワーカーの動きが表示されます。

- `/prompts` — 依頼文テンプレートの一覧(`docs/prompts/`)
- `/prompt <名前>` — テンプレートを表示してコピー&穴埋めして使う
- `exit` / `quit` — 終了
- `Ctrl+C` — 実行中のターンを中断(待機中なら終了)

### ワンショット実行(朝バッチ・スクリプト連携用)

対話せず1タスクだけ実行して終了します:

```bash
npm run task -- "srcディレクトリを監査して問題点をdocs/audit.mdにまとめて"
```

cron/launchdに載せれば定期実行も可能です。

### 使いこなしガイド

- [`docs/HERMES_PLAYBOOK.md`](docs/HERMES_PLAYBOOK.md) — バリューを産む使い方(ユースケース集・依頼文の書き方・運用ルーチン)
- [`docs/OSS_STRATEGY.md`](docs/OSS_STRATEGY.md) — 業務自動化ツールをOSSとして量産する戦略
- [`docs/prompts/`](docs/prompts/) — 実戦用の依頼文テンプレート(うまくいった依頼文はここに追加してストックする)

## 設定(環境変数)

| 変数 | 既定値 | 説明 |
|---|---|---|
| `MULTIAGENT_MODEL` | `opus` | オーケストレーターのモデル。コスト重視なら `sonnet` |
| `MULTIAGENT_AUTH` | (なし) | `login` で `ANTHROPIC_API_KEY` を無視して Claude Code ログイン認証を使う |

ワーカーの構成(役割・ツール・モデル)は `src/agents.ts` で定義。エージェントの追加・変更はこのファイルを編集するだけです。

## ブラウザ操作(GUI)

`operator` ワーカーが Playwright MCP 経由でブラウザを操作できます(画面遷移・クリック・フォーム入力・情報取得・スクリーンショット)。

```
あなた> ◯◯のサイトを開いて、△△の一覧を取得してCSVにまとめて
```

- 初回実行時に `npx @playwright/mcp@latest` の取得で少し時間がかかることがあります
- ログインが必要なサイトは認証情報の渡し方に注意(プロンプトに書いたものは履歴に残る)
- 購入・送信・削除など不可逆な操作は、明示的に許可しない限り operator は直前で停止する設計です
- ネイティブアプリのGUI操作は未対応(必要なら AppleScript / computer-use で拡張可能)

## 注意

- `permissionMode: "bypassPermissions"` で動くため、ワーカーは**確認なしにファイル編集・コマンド実行**を行います。個人環境での利用を前提とし、信頼できないタスクを投げないでください。共有環境では `src/orchestrator.ts` で `permissionMode` を `acceptEdits` に変更し、`canUseTool` コールバックで許可制御を実装してください
- オーケストレーターに Opus を使うためコストは高めです。1ターンあたりの費用はターン完了時に表示されます

## 構成ファイル

| ファイル | 役割 |
|---|---|
| `src/index.ts` | CLI(REPL)。出力のストリーミング表示とワーカー活動の可視化 |
| `src/orchestrator.ts` | セッション管理。streaming input で `query()` を1本維持 |
| `src/agents.ts` | オーケストレーター/ワーカーのエージェント定義 |

## 拡張のヒント

- **ワーカー追加**: `src/agents.ts` の `workers` にエントリを追加(`description` がオーケストレーターの委譲判断に使われるので具体的に書く)
- **カスタムツール**: SDK の `tool()` + `createSdkMcpServer()` でインプロセスMCPツールを定義し、`Options.mcpServers` に渡す(例: 社内API呼び出し、DB接続)
- **バックグラウンドワーカー**: `AgentDefinition.background: true` で fire-and-forget 実行
- **セッション再開**: `query()` の `resume: <sessionId>` オプションで過去セッションを継続可能
