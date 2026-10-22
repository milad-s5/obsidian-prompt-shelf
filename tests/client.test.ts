import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { stub, StubRequest } from "./obsidian-stub";
import { AiClient } from "../src/ai/AiClient";
import { Provider } from "../src/types";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

const img = { mime: "image/png" as const, data: "iVBORw0KGgo" };

function client(providers: Provider[], defaultModel = "", fallbackModels: string[] = []) {
  const plugin = {
    settings: { providers, defaultModel, fallbackModels, streaming: false, timeoutSec: 5, maxTokens: 1000 },
    keys: { has: () => true, get: () => "k" },
  };
  return new AiClient(plugin as never);
}

const openrouter: Provider = { id: "or", name: "OpenRouter", type: "openai", baseUrl: "https://or/v1", models: ["deepseek-r1:free", "gpt-4o-mini"] };
const google: Provider = { id: "g", name: "Gemini", type: "gemini", baseUrl: "https://g/v1beta", models: ["gemini-flash-latest"] };

const sentModel = (r: StubRequest): string => {
  const body = JSON.parse(r.body ?? "{}") as { model?: string };
  return body.model ?? r.url.replace(/^.*\/models\/|:generateContent$/g, "");
};

const okOpenai = { status: 200, text: JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }) };
const okGemini = { status: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] }) };

beforeEach(() => {
  stub.requests = [];
  stub.respond = (r) => (r.url.includes("generateContent") ? okGemini : okOpenai);
});

test("a request with images skips models that are not marked for images", async () => {
  const c = client([openrouter, google], "or|deepseek-r1:free", ["or|gpt-4o-mini", "g|gemini-flash-latest"]);
  assert.deepEqual(c.candidates("", { images: true }).map((t) => t.model), ["gpt-4o-mini", "gemini-flash-latest"]);
  await c.chat({ messages: [{ role: "user", content: "Describe", images: [img] }] });
  assert.deepEqual(stub.requests.map(sentModel), ["gpt-4o-mini"]);
});

test("text-only requests still use the whole chain", () => {
  const c = client([openrouter, google], "or|deepseek-r1:free", ["or|gpt-4o-mini"]);
  assert.deepEqual(c.candidates().map((t) => t.model), ["deepseek-r1:free", "gpt-4o-mini"]);
});

test("a model's own toggle overrides its name", () => {
  const p: Provider = { ...openrouter, modelFlags: { "deepseek-r1:free": { images: true }, "gpt-4o-mini": { images: false } } };
  const c = client([p], "or|deepseek-r1:free", ["or|gpt-4o-mini"]);
  assert.deepEqual(c.candidates("", { images: true }).map((t) => t.model), ["deepseek-r1:free"]);
});

test("fails clearly when no model accepts images", async () => {
  const c = client([{ ...openrouter, models: ["deepseek-r1:free"] }], "or|deepseek-r1:free");
  await assert.rejects(c.chat({ messages: [{ role: "user", content: "x", images: [img] }] }), /No model that accepts images is set up/);
  assert.equal(stub.requests.length, 0);
});

test("audio only reaches models marked for audio", async () => {
  const c = client([openrouter, google], "or|gpt-4o-mini", ["g|gemini-flash-latest"]);
  await c.chat({ messages: [{ role: "user", content: "Transcribe", audio: [{ mime: "audio/mpeg", data: "SUQz" }] }] });
  assert.deepEqual(stub.requests.map(sentModel), ["gemini-flash-latest"]);
});

test("rejects images over 8 MB before sending anything", async () => {
  const c = client([google], "g|gemini-flash-latest");
  const big = { mime: "image/png" as const, data: "A".repeat(8 * 1024 * 1024 + 1) };
  await assert.rejects(c.chat({ messages: [{ role: "user", content: "x", images: [big] }] }), /limit is 8\.0 MB/);
  assert.equal(stub.requests.length, 0);
});

test("json answers come back without fences", async () => {
  stub.respond = () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] }) });
  const r = await client([openrouter], "or|gpt-4o-mini").chat({ prompt: "Give JSON", json: true });
  assert.equal(r.text, '{"a":1}');
});

test("openai retries once without response_format when it gets a 400", async () => {
  stub.respond = (r) => {
    const body = JSON.parse(r.body ?? "{}") as { response_format?: unknown };
    return body.response_format
      ? { status: 400, text: JSON.stringify({ error: { message: "response_format is not supported" } }) }
      : { status: 200, text: JSON.stringify({ choices: [{ message: { content: '{"b":2}' } }] }) };
  };
  const r = await client([openrouter], "or|gpt-4o-mini").chat({ prompt: "Give JSON", json: true });
  assert.equal(r.text, '{"b":2}');
  assert.equal(stub.requests.length, 2);
});

test("capabilities reflect the models that are set up", () => {
  assert.deepEqual(client([{ ...openrouter, models: ["deepseek-r1:free"] }]).capabilities(), { images: false, audio: false, json: true });
  assert.deepEqual(client([openrouter, google]).capabilities(), { images: true, audio: true, json: true });
});
