import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS, ChatParams } from "../src/ai/adapters";

const base: ChatParams = {
  system: "Be brief.",
  messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi" },
    { role: "user", content: "Summarize this" },
  ],
  model: "m",
  stream: false,
};

test("openai text-only body is unchanged", () => {
  const r = ADAPTERS.openai.chat("https://api.openai.com/v1", "k", { ...base, temperature: 0.2, maxTokens: 100 });
  assert.equal(r.url, "https://api.openai.com/v1/chat/completions");
  assert.deepEqual(r.headers, { Authorization: "Bearer k" });
  assert.deepEqual(r.body, {
    model: "m",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Summarize this" },
    ],
    temperature: 0.2,
    max_tokens: 100,
  });
});

test("openai text-only body with thinking and streaming is unchanged", () => {
  const r = ADAPTERS.openai.chat("https://openrouter.ai/api/v1", "k", { ...base, system: "", thinking: "low", stream: true });
  assert.deepEqual(r.body, {
    model: "m",
    messages: base.messages,
    reasoning: { effort: "low" },
    stream: true,
  });
});

test("anthropic text-only body is unchanged", () => {
  const r = ADAPTERS.anthropic.chat("https://api.anthropic.com/v1", "k", { ...base, maxTokens: 1000 });
  assert.equal(r.url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(r.body, { model: "m", max_tokens: 1000, messages: base.messages, system: "Be brief." });
});

test("gemini text-only body is unchanged", () => {
  const r = ADAPTERS.gemini.chat("https://g/v1beta", "k", { ...base, thinking: "off" });
  assert.equal(r.url, "https://g/v1beta/models/m:generateContent");
  assert.deepEqual(r.headers, { "x-goog-api-key": "k" });
  assert.deepEqual(r.body, {
    contents: [
      { role: "user", parts: [{ text: "Hello" }] },
      { role: "model", parts: [{ text: "Hi" }] },
      { role: "user", parts: [{ text: "Summarize this" }] },
    ],
    systemInstruction: { parts: [{ text: "Be brief." }] },
    generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
  });
});
