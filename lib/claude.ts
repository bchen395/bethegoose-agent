/**
 * lib/claude.ts — shared Claude API access.
 *
 * Two callers go through here: the weekly Strategy Agent (lib/agents/strategy.ts)
 * and the on-demand "reuse your hits" helper (app/api/insights/reuse). Both use
 * this module so that:
 *   - the client is created once (lazily) from a SERVER-ONLY env var,
 *   - structured output is forced via tool-use and validated with zod, with one
 *     retry, then raised as AgentError on final failure (the caller writes
 *     nothing half-baked),
 *   - web search is a separate, cost-capped call (each search is billable).
 *
 * SERVER-ONLY — never import into a client component (ANTHROPIC_API_KEY must not
 * reach the browser). The tool's `input_schema` is derived from the zod schema
 * (single source of truth), and the model's tool-call arguments are validated
 * against that same schema.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { insertUsageLog } from "./db";

// --- Models -----------------------------------------------------------------

export const STRATEGY_MODEL = "claude-sonnet-4-6"; // weekly plan — editorial judgment
export const CONTENT_MODEL = "claude-haiku-4-5-20251001"; // on-demand "reuse your hits" ideas

// Each web search is billable; the Strategy Agent runs 2-3 per run.
export const MAX_WEB_SEARCHES = 3;

// --- Cost meter (FEATURES.md §7) --------------------------------------------

/**
 * Which caller a model call belongs to (a subset of the usage_log.agent CHECK,
 * which still permits the retired 'distribution' value for legacy rows).
 */
export type UsageAgent = "strategy" | "content";

/**
 * ⚠ Anthropic prices — confirmed 2026-06-13 (claude-api skill + platform docs).
 * USD per 1M tokens. If Anthropic changes prices, update THIS map only — it's the
 * single source of truth for the cost meter. Treat like the other ⚠ placeholders.
 */
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** ⚠ Web search: $10 per 1,000 searches (confirmed 2026-06-13). */
const WEB_SEARCH_PRICE_PER_SEARCH = 10 / 1000;

/** Estimated USD cost of one call. Unknown model -> token cost 0 (searches still count). */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  webSearches: number,
): number {
  const price =
    MODEL_PRICES[model] ??
    Object.entries(MODEL_PRICES).find(([id]) => model.startsWith(id))?.[1] ??
    null;
  const tokenCost = price
    ? (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output
    : 0;
  return tokenCost + webSearches * WEB_SEARCH_PRICE_PER_SEARCH;
}

/** Pull (input, output, web_search) counts off a response's usage block. */
function readUsage(resp: Anthropic.Message): {
  input: number;
  output: number;
  webSearches: number;
} {
  const u = resp.usage as
    | { input_tokens?: number; output_tokens?: number; server_tool_use?: { web_search_requests?: number } }
    | undefined;
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    webSearches: u?.server_tool_use?.web_search_requests ?? 0,
  };
}

/**
 * Log one usage_log row. Never throws — a logging failure must not break an agent
 * (FEATURES.md §7). Skips silently when no agent label is supplied.
 */
async function logUsage(
  agent: UsageAgent | undefined,
  model: string,
  usage: { input: number; output: number; webSearches: number },
): Promise<void> {
  if (!agent) return;
  try {
    await insertUsageLog({
      agent,
      model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      webSearches: usage.webSearches,
      estCostUsd: estimateCost(model, usage.input, usage.output, usage.webSearches),
    });
  } catch {
    // swallow: logging is best-effort and must never break the agent.
  }
}

// Current web-search tool version (server-side; searches + synthesizes in one turn).
const WEB_SEARCH_TOOL = "web_search_20260209";

let _client: Anthropic | null = null;

/**
 * A model call could not produce usable output. On this error the caller writes
 * nothing and surfaces the message to the UI.
 */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

// --- Client -----------------------------------------------------------------

export function getClient(): Anthropic {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key === "your_key_here") {
      throw new AgentError("ANTHROPIC_API_KEY is not set — add your real key to .env.local");
    }
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

// --- JSON parsing (fallback for string-typed tool arguments) ----------------

function stripFences(text: string): string {
  const t = text.trim();
  if (!t.startsWith("```")) return t;
  let lines = t.split("\n").slice(1); // drop opening ``` / ```json
  if (lines.length && lines[lines.length - 1].trim().startsWith("```")) {
    lines = lines.slice(0, -1); // drop closing ```
  }
  return lines.join("\n").trim();
}

function parseJsonObject(text: string): unknown {
  const candidate = stripFences(text);
  let data: unknown;
  try {
    data = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("could not parse JSON object from text");
    data = JSON.parse(candidate.slice(start, end + 1));
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("model returned JSON that is not an object");
  }
  return data;
}

function extractToolResult(resp: Anthropic.Message, toolName: string): unknown {
  if (resp.stop_reason === "refusal") {
    const detail = (resp as { stop_details?: { explanation?: string } }).stop_details?.explanation;
    throw new AgentError(`Model refused the request: ${detail || "no detail given"}`);
  }

  for (const block of resp.content as Array<{ type: string; name?: string; input?: unknown }>) {
    if (block.type === "tool_use" && block.name === toolName) {
      const args = block.input;
      if (typeof args === "object" && args !== null) return args;
      if (typeof args === "string") return parseJsonObject(args); // defensive
      throw new Error(`tool arguments were ${typeof args}, not an object`);
    }
  }

  if (resp.stop_reason === "max_tokens") {
    throw new Error("output hit max_tokens before the tool call completed");
  }
  throw new Error(`no '${toolName}' tool call in the response`);
}

// --- Forced-JSON call -------------------------------------------------------

export async function callJson<T>(opts: {
  model: string;
  system: string;
  content: string | Anthropic.ContentBlockParam[];
  schema: z.ZodType<T>;
  toolName?: string;
  toolDescription?: string;
  maxTokens?: number;
  agent?: UsageAgent;
}): Promise<T> {
  const {
    model,
    system,
    content,
    schema,
    toolName = "record",
    toolDescription = "Record the structured result.",
    maxTokens = 2048,
    agent,
  } = opts;

  const client = getClient();
  const inputSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete inputSchema.$schema;
  const tool = { name: toolName, description: toolDescription, input_schema: inputSchema };

  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const sysPrompt =
      attempt === 0
        ? system
        : system +
          `\n\nCall the \`${toolName}\` tool exactly once with a single complete argument ` +
          "object that matches the schema. Do not include any other text.";

    let resp: Anthropic.Message;
    try {
      resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: sysPrompt,
        messages: [{ role: "user", content }],
        // SDK tool-type unions drift across versions; the API accepts this shape.
        tools: [tool] as unknown as Anthropic.MessageCreateParamsNonStreaming["tools"],
        tool_choice: { type: "tool", name: toolName },
      });
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        throw new AgentError(`Claude API call failed: ${e.message}`);
      }
      throw e;
    }

    // Meter every billed attempt (a retry is a second billable call).
    await logUsage(agent, model, readUsage(resp));

    try {
      const raw = extractToolResult(resp, toolName);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`output did not match the schema: ${parsed.error.message}`);
      }
      return parsed.data;
    } catch (e) {
      if (e instanceof AgentError) throw e; // refusal propagates immediately
      lastError = e; // fall through to the retry
    }
  }

  throw new AgentError(
    `Could not get valid JSON from the model after a retry: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

// --- Web search -------------------------------------------------------------

/**
 * Run up to `maxSearches` web searches and return synthesized findings.
 * Returns { text: <synthesis>, queries: [<queries run>] }. The Strategy Agent
 * feeds the text into callJson as supplementary context — it does not loop.
 */
export async function webSearch(opts: {
  prompt: string;
  model?: string;
  system?: string;
  maxSearches?: number;
  maxTokens?: number;
  agent?: UsageAgent;
}): Promise<{ text: string; queries: string[] }> {
  const {
    prompt,
    model = STRATEGY_MODEL,
    system,
    maxSearches = MAX_WEB_SEARCHES,
    maxTokens = 4096,
    agent,
  } = opts;

  const client = getClient();
  const capped = Math.max(1, Math.min(Math.trunc(maxSearches), MAX_WEB_SEARCHES));
  const tools = [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: capped }];

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const queries: string[] = [];
  const textParts: string[] = [];
  const acc = { input: 0, output: 0, webSearches: 0 }; // summed across pause_turn loop

  for (let i = 0; i < 5; i++) {
    // bounded: handle pause_turn
    let resp: Anthropic.Message;
    try {
      resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages,
        tools: tools as unknown as Anthropic.MessageCreateParamsNonStreaming["tools"],
        ...(system ? { system } : {}),
      });
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        throw new AgentError(`Web search call failed: ${e.message}`);
      }
      throw e;
    }

    const u = readUsage(resp);
    acc.input += u.input;
    acc.output += u.output;
    acc.webSearches += u.webSearches;

    for (const block of resp.content as Array<{ type: string; name?: string; input?: unknown; text?: string }>) {
      if (block.type === "server_tool_use" && block.name === "web_search") {
        const input = block.input;
        const query =
          input && typeof input === "object" && "query" in input
            ? (input as { query?: unknown }).query
            : undefined;
        if (typeof query === "string" && query) queries.push(query);
      } else if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      }
    }

    if (resp.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: resp.content });
      continue;
    }
    break;
  }

  await logUsage(agent, model, acc); // one row for the whole search turn
  return { text: textParts.filter(Boolean).join("\n").trim(), queries };
}
