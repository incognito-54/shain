import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { workers, orchestratorPrompt } from "./agents.js";

/**
 * 永続的な対話セッションを持つオーケストレーター。
 * streaming input モード(AsyncIterable<SDKUserMessage>)で query() を1本だけ張り、
 * ユーザー入力を随時キューに積むことで文脈を維持したまま多ターン対話する。
 */
export class Orchestrator {
  private queue: SDKUserMessage[] = [];
  private notify: (() => void) | null = null;
  private closed = false;
  readonly session: Query;

  constructor(opts?: { cwd?: string; permissionMode?: Options["permissionMode"] }) {
    // SHAIN_AUTH=login のときは ANTHROPIC_API_KEY を外し、
    // Claude Code のログイン認証(サブスクリプション)にフォールバックさせる。
    // シェルに古いAPIキーが export されていて認証エラーになる場合に使う。
    const env = { ...process.env } as Record<string, string>;
    if (process.env.SHAIN_AUTH === "login") {
      delete env.ANTHROPIC_API_KEY;
    }

    const options: Options = {
      env,
      model: process.env.SHAIN_MODEL ?? "opus",
      cwd: opts?.cwd ?? process.cwd(),
      // 個人用途前提。ワーカーを止めずに走らせるため許可プロンプトを省略する。
      // 共有環境では 'acceptEdits' + canUseTool に切り替えること(README参照)。
      permissionMode: opts?.permissionMode ?? "bypassPermissions",
      systemPrompt: { type: "preset", preset: "claude_code" },
      // ブラウザ操作用MCP。operatorワーカーが名前参照で利用する
      mcpServers: {
        playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      },
      // メインスレッドをオーケストレーターエージェントとして実行する。
      // ツール制限は orchestrator 定義側に持たせる(Options.tools でグローバルに
      // 制限するとワーカーの Write/Bash まで消えてしまうため使わない)。
      agent: "orchestrator",
      agents: {
        orchestrator: {
          description: "ユーザーとの対話窓口。タスクを分解しワーカーに委譲する。",
          prompt: orchestratorPrompt,
          // 自身は委譲・閲覧・計画のみ。重い作業はワーカーのツールで行う。
          tools: ["Agent", "Read", "Glob", "Grep", "TodoWrite"],
        },
        ...workers,
      },
      includePartialMessages: true,
    };

    this.session = query({ prompt: this.input(), options });
  }

  /** ユーザー入力を1ターン分投入する */
  send(text: string): void {
    this.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    this.notify?.();
    this.notify = null;
  }

  /** 実行中のターンを中断する */
  async interrupt(): Promise<void> {
    await this.session.interrupt();
  }

  /** セッションを終了する */
  close(): void {
    this.closed = true;
    this.notify?.();
    this.notify = null;
  }

  /** SDKへ流し込む入力ストリーム */
  private async *input(): AsyncIterable<SDKUserMessage> {
    while (!this.closed) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.closed) break;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
  }

  /** 出力メッセージストリーム(index.ts が消費) */
  messages(): AsyncGenerator<SDKMessage, void> {
    return this.session;
  }
}
