import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { stub } from "./obsidian-stub";
import { AiClient } from "../src/ai/AiClient";
import { Provider, ProviderType } from "../src/types";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

const sse = (events: string[]) =>
  new Response(new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const e of events) c.enqueue(enc.encode(e));
      c.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });

let sent: { url: string; body: Record<string, unknown> } | null = null;

function run(type: ProviderType, respond: () => Response, extra: { json?: boolean } = {}) {
  const plugin = {
    settings: { providers: [], defaultModel: "", fallbackModels: [], streaming: true, timeoutSec: 2, maxTokens: 1000 },
    keys: { has: () => true, get: () => "k" },
  };
  globalThis.fetch = ((url: string, init: { body: string }) => {
    sent = { url, body: JSON.parse(init.body) as Record<string, unknown> };
    return Promise.resolve(respond());
  }) as unknown as typeof fetch;
  const provider: Provider = { id: "p", name: "P", type, baseUrl: "https://x/v1", models: ["m"] };
  const deltas: string[] = [];
  const done = new AiClient(plugin as never).chatWith({ provider, model: "gemini-flash-latest" }, { prompt: "hi", onDelta: (t) => deltas.push(t), ...extra });
  return { done, deltas };
}

beforeEach(() => {
  sent = null;
  stub.requests = [];
});

test("openai stream is assembled across split chunks", async () => {
  const { done, deltas } = run("openai", () => sse([
    ": OPENROUTER PROCESSING\n\n",
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"del',
    'ta":{"content":"lo"},"finish_reason":"length"}]}\n\n',
    "data: [DONE]\n\n",
  ]));
  const r = await done;
  assert.equal(r.text, "Hello");
  assert.equal(r.truncated, true);
  assert.equal(deltas.length, 2);
});

test("anthropic stream keeps only text deltas", async () => {
  const { done } = run("anthropic", () => sse([
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"سلام"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  ]));
  assert.equal((await done).text, "سلام");
});

test("gemini stream skips thought parts and uses the stream endpoint", async () => {
  const { done } = run("gemini", () => sse([
    'data: {"candidates":[{"content":{"parts":[{"text":"thinking","thought":true},{"text":"A"}]}}]}\r\n\r\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"B"}]},"finishReason":"STOP"}]}\r\n\r\n',
  ]));
  assert.equal((await done).text, "AB");
  assert.match(sent?.url ?? "", /:streamGenerateContent\?alt=sse$/);
});

test("an error in the middle of a stream is reported by kind", async () => {
  const { done } = run("openai", () => sse([
    'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
    'data: {"error":{"code":429,"message":"Rate limit exceeded upstream"}}\n\n',
  ]));
  await assert.rejects(done, (e: { kind?: string }) => e.kind === "rate-limit");
});

test("a blocked fetch falls back to requestUrl", async () => {
  stub.respond = () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: "via requestUrl" } }] }) });
  const { done } = run("openai", () => {
    throw new TypeError("Failed to fetch");
  });
  assert.equal((await done).text, "via requestUrl");
  assert.equal(stub.requests.length, 1);
});

test("a stalled stream times out", async () => {
  const { done } = run("openai", () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(done, (e: { kind?: string }) => e.kind === "timeout");
});

test("json over a stream is returned without fences", async () => {
  const { done } = run("openai", () => sse(['data: {"choices":[{"delta":{"content":"```json\\n{\\"a\\":1}\\n```"}}]}\n\n']), { json: true });
  assert.equal((await done).text, '{"a":1}');
  assert.deepEqual(sent?.body.response_format, { type: "json_object" });
});
