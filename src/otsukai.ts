import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Otsukai(お使い) — ユーザーの代わりにブラウザで用事を片づける単機能CLI。
 *
 *   npm run otsukai -- "ヨドバシで〇〇の在庫と最安値を調べて"
 *
 * 設計の芯: 「見る・調べる」は自由。ただし『取り消せない操作』(予約確定・申込送信・
 * 購入/決済・メッセージ送信・削除・退会)は絶対に自分で実行せず、直前の画面で手を止めて
 * ユーザーに確認を求める。= 優秀だが権限のないお使い係。
 *
 * Shain の operator ワーカーと同じ Playwright MCP を使うが、Otsukai は「お使い1件を
 * 最後まで遂行して報告する」単一エージェントのワンショットに特化している。
 */

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

// ---- お使いの依頼文(位置引数をすべて連結)
const errand = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("-"))
  .join(" ")
  .trim();

if (!errand) {
  console.error(
    [
      '使い方: npm run otsukai -- "頼みたいお使い"',
      "",
      "例:",
      '  npm run otsukai -- "食べログで新宿の寿司を評価順に3件、予算と定休日つきで調べて"',
      '  npm run otsukai -- "航空券サイトで来週金曜の羽田→福岡の最安を予約直前まで進めて"',
      "",
      "※ 予約確定・購入・送信・削除などの取り消せない操作は、直前で必ず止まります。",
    ].join("\n"),
  );
  process.exit(1);
}

const OTSUKAI_RULES = [
  "あなたは「Otsukai(お使い)」です。ユーザーの代わりに Web ブラウザで用事を片づけます。",
  "Playwright ツール(mcp__playwright__*)でブラウザを操作します。",
  "",
  "## お使いの作法(厳守。これがこの道具の信頼の源泉)",
  "- 「見る・調べる・探す・比較する・下書きする」は自由に進めてよい。",
  "- ただし『取り消せない操作』は、いかなる場合も自分で実行しない。具体的には:",
  "    予約の確定 / 申込・応募の送信 / 購入・決済・支払い / メッセージ送信 /",
  "    投稿・公開 / 予約や注文のキャンセル / 削除 / 退会。",
  "  これらは【実行の直前の画面まで】進めて手を止め、ユーザーの確認を待つ。押さない。",
  "- ログインや個人情報の入力が必要で、それが与えられていない場合は、その手前で止めて報告する。",
  "  認証情報を勝手に推測・入力しない。",
  "- 操作の前に必ずページのスナップショットで状態を確認し、要素を特定してから操作する。",
  "- お金・数量・宛先・日時など間違えると困る項目は、入力後に読み上げて確認できる形で残す。",
  "",
  "## 最後に必ず日本語で報告する(この3点を構造化して)",
  "1) やったこと: 訪れたページ、調べて分かったこと(価格・空き・比較結果などは具体的に)",
  "2) いま止まっている地点: どの画面で、あと何を押せば完了するのか",
  "3) ユーザーが判断・実行すべきこと(取り消せない操作は必ずここに回す)",
  "",
  "お使いが最後まで安全に終わったら、その旨も明記する。",
].join("\n");

// ---- 認証: SHAIN_AUTH=login のときは APIキーを外し Claude Code ログインにフォールバック
const env = { ...process.env } as Record<string, string>;
if (process.env.SHAIN_AUTH === "login") {
  delete env.ANTHROPIC_API_KEY;
}

const options: Options = {
  env,
  // ブラウザ操作は sonnet で十分(コスト最適)。OTSUKAI_MODEL で上書き可
  model: process.env.OTSUKAI_MODEL ?? "sonnet",
  cwd: process.cwd(),
  // 個人利用前提。ツール許可プロンプトは出さない(不可逆操作の抑止はプロンプト規約で担保)
  permissionMode: "bypassPermissions",
  systemPrompt: { type: "preset", preset: "claude_code" },
  mcpServers: {
    playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
  },
  agent: "otsukai",
  agents: {
    otsukai: {
      description: "ユーザーの代わりにブラウザで用事(調査・比較・予約直前まで)を片づけるお使い係。",
      prompt: OTSUKAI_RULES,
      mcpServers: ["playwright"],
    },
  },
  includePartialMessages: true,
};

console.log(green("=== Otsukai(お使い) ==="));
console.log(dim(`頼まれたお使い: ${errand}`));
console.log(dim("(予約確定・購入・送信・削除などは実行せず、直前で止めて報告します)\n"));

function render(msg: SDKMessage): boolean {
  switch (msg.type) {
    case "stream_event": {
      const ev = msg.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        process.stdout.write(ev.delta.text);
      }
      return false;
    }
    case "assistant": {
      for (const block of msg.message.content) {
        if (block.type === "tool_use") {
          const name = block.name.replace(/^mcp__playwright__/, "🌐 ");
          console.log(cyan(`\n  ・${name}`));
        }
      }
      return false;
    }
    case "result": {
      if (msg.subtype === "success") {
        console.log(
          dim(
            `\n\n─ お使い完了: ${(msg.duration_ms / 1000).toFixed(1)}s / ` +
              `$${msg.total_cost_usd.toFixed(4)}`,
          ),
        );
      } else {
        console.log(yellow(`\n\n─ 中断/エラー (${msg.subtype})`));
      }
      return true;
    }
    default:
      return false;
  }
}

const session = query({ prompt: errand, options });
for await (const msg of session) {
  if (render(msg)) break;
}
process.exit(0);
