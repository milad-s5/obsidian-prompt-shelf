import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS, ChatParams } from "../src/ai/adapters";
import { stripFences } from "../src/ai/json";

const img = { mime: "image/png" as const, data: "iVBORw0KGgo" };
const jpg = { mime: "image/jpeg" as const, data: "/9j/4AAQ" };
const mp3 = { mime: "audio/mpeg" as const, data: "SUQzBAA" };

const withImages: ChatParams = {
  system: "",
  messages: [{ role: "user", content: "What is in these?", images: [img, jpg] }],
  model: "m",
  stream: false,
};

test("openai maps images to image_url parts after the text", () => {
  const body = ADAPTERS.openai.chat("https://x/v1", "k", withImages).body as Record<string, unknown>;
  assert.deepEqual(body.messages, [{
    role: "user",
    content: [
      { type: "text", text: "What is in these?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
    ],
  }]);
});

test("gemini maps images to inline_data parts after the text", () => {
  const body = ADAPTERS.gemini.chat("https://g/v1beta", "k", withImages).body as Record<string, unknown>;
  assert.deepEqual(body.contents, [{
    role: "user",
    parts: [
      { text: "What is in these?" },
      { inline_data: { mime_type: "image/png", data: "iVBORw0KGgo" } },
      { inline_data: { mime_type: "image/jpeg", data: "/9j/4AAQ" } },
    ],
  }]);
});

test("anthropic maps images to base64 sources before the text", () => {
  const body = ADAPTERS.anthropic.chat("https://a/v1", "k", { ...withImages, maxTokens: 10 }).body as Record<string, unknown>;
  assert.deepEqual(body.messages, [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } },
      { type: "text", text: "What is in these?" },
    ],
  }]);
});

test("only the message that carries images changes shape", () => {
  const p: ChatParams = {
    system: "",
    messages: [{ role: "user", content: "Earlier" }, { role: "assistant", content: "Ok" }, { role: "user", content: "Now this", images: [img] }],
    model: "m",
    stream: false,
  };
  const msgs = (ADAPTERS.openai.chat("https://x/v1", "k", p).body as { messages: unknown[] }).messages;
  assert.deepEqual(msgs.slice(0, 2), [{ role: "user", content: "Earlier" }, { role: "assistant", content: "Ok" }]);
});

test("an empty images list sends the same body as no images at all", () => {
  const plain: ChatParams = { system: "s", messages: [{ role: "user", content: "Hi" }], model: "m", stream: false };
  const empty: ChatParams = { ...plain, messages: [{ role: "user", content: "Hi", images: [], audio: [] }] };
  for (const type of ["openai", "gemini", "anthropic"] as const) {
    assert.deepEqual(ADAPTERS[type].chat("https://x/v1", "k", empty).body, ADAPTERS[type].chat("https://x/v1", "k", plain).body, type);
  }
});

test("openai maps audio to input_audio with a format name", () => {
  const body = ADAPTERS.openai.chat("https://x/v1", "k", {
    system: "", model: "m", stream: false,
    messages: [{ role: "user", content: "Transcribe", audio: [mp3, { mime: "audio/wav", data: "UklGR" }] }],
  }).body as Record<string, unknown>;
  assert.deepEqual(body.messages, [{
    role: "user",
    content: [
      { type: "text", text: "Transcribe" },
      { type: "input_audio", input_audio: { data: "SUQzBAA", format: "mp3" } },
      { type: "input_audio", input_audio: { data: "UklGR", format: "wav" } },
    ],
  }]);
});

test("gemini maps audio to inline_data", () => {
  const body = ADAPTERS.gemini.chat("https://g/v1beta", "k", {
    system: "", model: "m", stream: false,
    messages: [{ role: "user", content: "Transcribe", audio: [mp3] }],
  }).body as Record<string, unknown>;
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "Transcribe" }, { inline_data: { mime_type: "audio/mpeg", data: "SUQzBAA" } }] }]);
});

test("anthropic refuses audio with a clear error", () => {
  assert.throws(
    () => ADAPTERS.anthropic.chat("https://a/v1", "k", { system: "", model: "m", stream: false, messages: [{ role: "user", content: "x", audio: [mp3] }] }),
    /Anthropic models do not accept audio/
  );
});

test("json asks each provider in its own way", () => {
  const p: ChatParams = { system: "", messages: [{ role: "user", content: "Give JSON" }], model: "m", stream: false, json: true };
  assert.deepEqual((ADAPTERS.openai.chat("https://x/v1", "k", p).body as Record<string, unknown>).response_format, { type: "json_object" });
  assert.deepEqual((ADAPTERS.gemini.chat("https://g", "k", p).body as Record<string, unknown>).generationConfig, { responseMimeType: "application/json" });
  const anthropic = ADAPTERS.anthropic.chat("https://a", "k", { ...p, maxTokens: 10 }).body as Record<string, unknown>;
  assert.equal("response_format" in anthropic, false);
});

test("stripFences returns the JSON inside a fence", () => {
  assert.equal(stripFences('```json\n{"a": 1}\n```'), '{"a": 1}');
  assert.equal(stripFences('```\n[1, 2]\n```'), "[1, 2]");
  assert.equal(stripFences('Here it is:\n```json\n{"ok": true}\n```\nAnything else?'), '{"ok": true}');
  assert.equal(stripFences('  {"plain": "yes"}  '), '{"plain": "yes"}');
  assert.equal(stripFences('```json\r\n{"crlf": 1}\r\n```'), '{"crlf": 1}');
});
