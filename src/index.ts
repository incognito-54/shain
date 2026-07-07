import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "./orchestrator.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptsDir = path.join(projectRoot, "docs", "prompts");

// ---- 引数解析: ワンショットモード (`npm run task -- "依頼文"` / `tsx src/index.ts -p "依頼文"`)
function parseOneShotPrompt(): string | null {
  const args = process.argv.slice(2);
  const flagIdx = args.findIndex((a) => a === "-p" || a === "--prompt");
  if (flagIdx >= 0 && args[flagIdx + 1]) return args[flagIdx + 1];
  // フラグなしの位置引数もプロンプトとして扱う
  const positional = args.filter((a) => !a.startsWith("-"));
  return positional.length > 0 ? positional.join(" ") : null;
}

// ---- プロンプトテンプレート (docs/prompts/*.md)
function listTemplates(): string[] {
  try {
    return fs
      .readdirSync(promptsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

function showTemplate(name: string): void {
  const file = path.join(promptsDir, `${name}.md`);
  if (!fs.existsSync(file)) {
    console.log(yellow(`テンプレート "${name}" が見つかりません。/prompts で一覧を確認してください。`));
    return;
  }
  console.log(dim("─".repeat(40)));
  console.log(fs.readFileSync(file, "utf-8").trim());
  console.log(dim("─".repeat(40)));
  console.log(dim("↑ をコピーして ＿＿＿ を埋め、そのまま貼り付けてください。"));
}

/** REPLコマンドを処理。依頼として送るべき入力なら false を返す */
function handleCommand(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed === "/prompts") {
    const names = listTemplates();
    if (names.length === 0) {
      console.log(dim("docs/prompts/ にテンプレートがありません。"));
    } else {
      console.log(dim("利用可能なテンプレート(/prompt <名前> で表示):"));
      for (const n of names) console.log(`  /prompt ${n}`);
    }
    return true;
  }
  if (trimmed.startsWith("/prompt ")) {
    showTemplate(trimmed.slice("/prompt ".length).trim());
    return true;
  }
  if (trimmed === "/help") {
    printHelp();
    return true;
  }
  return false;
}

function printHelp(): void {
  console.log(dim(
    [
      "コマンド:",
      "  /prompts        依頼文テンプレートの一覧",
      "  /prompt <名前>  テンプレートを表示(コピーして穴埋めして使う)",
      "  /help           このヘルプ",
      "  exit / quit     終了",
      "  Ctrl+C          実行中ターンの中断",
      "",
      "ワンショット実行: npm run task -- \"依頼文\"  (1タスク実行して終了)",
      "活用ガイド: docs/SHAIN_PLAYBOOK.md",
    ].join("\n"),
  ));
}

// ---- 出力レンダリング(REPL/ワンショット共通)
function renderMessage(msg: SDKMessage): void {
  switch (msg.type) {
    case "stream_event": {
      if (msg.parent_tool_use_id) break; // ワーカー内部のストリームは流さない
      const ev = msg.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        process.stdout.write(ev.delta.text);
      }
      break;
    }
    case "assistant": {
      for (const block of msg.message.content) {
        if (block.type === "tool_use") {
          const input = block.input as Record<string, unknown>;
          if (block.name === "Agent" || block.name === "Task") {
            const worker = (input.subagent_type as string) ?? "worker";
            const desc = (input.description as string) ?? "";
            console.log(yellow(`\n▶ ワーカー起動 [${worker}] ${desc}`));
          } else if (msg.parent_tool_use_id) {
            console.log(dim(`    ・${block.name}`));
          }
        }
      }
      break;
    }
    case "system": {
      if (msg.subtype === "init") {
        console.log(dim(`セッション開始 (model: ${msg.model ?? "default"})`));
      }
      break;
    }
  }
}

function renderResult(msg: SDKMessage & { type: "result" }): number {
  if (msg.subtype === "success") {
    console.log(
      dim(
        `\n─ ターン完了: ${(msg.duration_ms / 1000).toFixed(1)}s / ` +
          `${msg.num_turns} turns / 累計 $${msg.total_cost_usd.toFixed(4)}`,
      ),
    );
    return msg.total_cost_usd;
  }
  console.log(yellow(`\n─ エラー終了 (${msg.subtype})`));
  const errors = (msg as { errors?: string[] }).errors;
  if (errors?.length) {
    console.log(yellow(`  ${errors.join("; ")}`));
    if (errors.some((e) => /api key|authentication/i.test(e))) {
      console.log(
        dim(
          "  ヒント: APIキーが無効です。`SHAIN_AUTH=login npm start` で\n" +
            "  Claude Code のログイン認証を使うか、有効な ANTHROPIC_API_KEY を設定してください。",
        ),
      );
    }
  }
  return 0;
}

// ---- ワンショットモード: 1タスク実行して終了(朝バッチ・cron用)
async function runOneShot(prompt: string): Promise<void> {
  const orch = new Orchestrator({ cwd: process.cwd() });
  orch.send(prompt);
  let exitCode = 0;
  for await (const msg of orch.messages()) {
    renderMessage(msg);
    if (msg.type === "result") {
      const cost = renderResult(msg);
      exitCode = msg.subtype === "success" ? 0 : 1;
      if (cost === 0 && msg.subtype !== "success") exitCode = 1;
      break;
    }
  }
  orch.close();
  process.exit(exitCode);
}

// ---- 対話モード(REPL)
async function runRepl(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // stdin が閉じられた後(パイプ入力の終端など)は "exit" として扱う
  let rlClosed = false;
  let pendingAsk: ((s: string) => void) | null = null;
  rl.on("close", () => {
    rlClosed = true;
    pendingAsk?.("exit");
    pendingAsk = null;
  });

  const askRaw = (): Promise<string> =>
    new Promise((resolve) => {
      if (rlClosed) return resolve("exit");
      pendingAsk = resolve;
      rl.question(cyan("\nあなた> "), (answer) => {
        pendingAsk = null;
        resolve(answer);
      });
    });

  /** コマンドを処理しつつ、送信すべき依頼文が来るまで訊き続ける */
  const ask = async (): Promise<string> => {
    for (;;) {
      const input = await askRaw();
      if (isExit(input)) return "exit";
      if (input.trim() === "") continue;
      if (handleCommand(input)) continue;
      return input;
    }
  };

  console.log(green("=== Shain: マルチエージェント基盤 ==="));
  console.log(dim("オーケストレーターが対話を受け、ワーカー(researcher/coder/reviewer/writer)に作業を委譲します。"));
  printHelp();

  const orch = new Orchestrator({ cwd: process.cwd() });

  let running = false;
  rl.on("SIGINT", async () => {
    if (running) {
      console.log(yellow("\n[中断要求を送信]"));
      await orch.interrupt().catch(() => {});
    } else {
      shutdown(orch, rl);
    }
  });

  // SHAIN_KICKOFF があれば、最初のユーザー入力の代わりに自動投入する。
  // `npm run hire`(AI社員の採用フロー)がこれを使い、起動と同時に面談を始める。
  const kickoff = process.env.SHAIN_KICKOFF?.trim();
  const first = kickoff && kickoff.length > 0 ? kickoff : await ask();
  if (isExit(first)) return shutdown(orch, rl);
  if (kickoff && kickoff.length > 0) {
    console.log(cyan("\nあなた> ") + dim("(AI社員の採用を開始します。画面の質問にふだんの言葉で答えてください)"));
  }
  orch.send(first);
  running = true;

  let sessionCost = 0;

  for await (const msg of orch.messages()) {
    renderMessage(msg);
    if (msg.type === "result") {
      running = false;
      const cost = renderResult(msg);
      if (cost > 0) sessionCost = cost;

      const next = await ask();
      if (isExit(next)) return shutdown(orch, rl, sessionCost);
      orch.send(next);
      running = true;
    }
  }

  shutdown(orch, rl, sessionCost);
}

function isExit(s: string): boolean {
  return ["exit", "quit", "/exit", "/quit"].includes(s.trim().toLowerCase());
}

function shutdown(orch: Orchestrator, rl: readline.Interface, cost?: number): void {
  if (cost !== undefined && cost > 0) {
    console.log(dim(`\nセッション累計コスト: $${cost.toFixed(4)}`));
  }
  console.log(green("終了します。"));
  orch.close();
  rl.close();
  process.exit(0);
}

const oneShotPrompt = parseOneShotPrompt();
const entry = oneShotPrompt ? runOneShot(oneShotPrompt) : runRepl();
entry.catch((err) => {
  console.error("致命的エラー:", err);
  process.exit(1);
});
