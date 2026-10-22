import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { stub, StubRequest } from "./obsidian-stub";
import { speechChunks, speechText } from "../src/speech/text";
import { joinAudio, playable, readWav } from "../src/speech/audio";
import { Synthesizer, quotaInfo } from "../src/speech/synth";
import { SpeechController } from "../src/speech/session";
import { AiClient } from "../src/ai/AiClient";
import { Provider } from "../src/types";

const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;

const gemini: Provider = { id: "g", name: "Gemini", type: "gemini", baseUrl: "https://g/v1beta", models: ["gemini-flash-latest"] };
const openai: Provider = { id: "o", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", models: ["gpt-5-mini"] };
const claude: Provider = { id: "a", name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com/v1", models: ["claude-haiku-5-5"] };
const openrouter: Provider = { id: "r", name: "OpenRouter", type: "openai", baseUrl: "https://openrouter.ai/api/v1", models: ["x"] };

function plugin(providers: Provider[], speechModels: string[] = []) {
  const p = {
    settings: { providers, speechModels, speechVoice: "", speechRate: 1, timeoutSec: 5, defaultModel: "", fallbackModels: [] },
    keys: { has: () => true, get: () => "k" },
    saveData: () => Promise.resolve(),
    app: {},
  } as Record<string, unknown>;
  p.client = new AiClient(p as never);
  return p;
}

const pcm = (n: number) => btoaBytes(new Uint8Array(n).fill(7));
function btoaBytes(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
const geminiAudio = (n = 8) => ({
  status: 200,
  text: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm(n) } }] } }] }),
});
const quota = (perDay: boolean) => ({
  status: 429,
  text: JSON.stringify({ error: { code: 429, message: "Quota exceeded", details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: perDay ? "GenerateRequestsPerDayPerProjectPerModel" : "GenerateRequestsPerMinutePerProjectPerModel" }] },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "17s" },
  ] } }),
});
const modelOf = (r: StubRequest) => /models\/([^:]+):/.exec(r.url)?.[1] ?? (JSON.parse(r.body ?? "{}") as { model?: string }).model;

beforeEach(() => {
  stub.requests = [];
  stub.respond = () => geminiAudio();
});

test("speechText drops markdown, links, code, timestamps and frontmatter", () => {
  const md = "---\ntags: x\n---\n# Title\n- **Bold** point [1:23]\n> [!note] Callout\nSee [the docs](https://x) and [[Page|this page]].\n```js\ncode()\n```\nEnd.";
  assert.equal(speechText(md), "Title\nBold point \nCallout\nSee the docs and this page.\n \nEnd.");
});

test("speechChunks starts small and grows, without splitting words", () => {
  const sentence = "This sentence has about sixty characters in it, roughly so. ";
  const chunks = speechChunks(sentence.repeat(120).trim());
  assert.ok(chunks[0].length <= 500 && chunks[1].length <= 1000 && chunks.every((c) => c.length <= 2000));
  assert.ok(chunks.length > 3);
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), sentence.repeat(120).trim().replace(/\s+/g, " "));
  const long = speechChunks("word ".repeat(1000).trim());
  assert.ok(long.every((c) => !c.startsWith(" ") && c.length <= 2000));
});

test("speechChunks splits Persian sentences too", () => {
  const fa = "این جمله‌ی اول است. این جمله‌ی دوم است؟ و این سومی!";
  assert.deepEqual(speechChunks(fa), [fa]);
  assert.equal(speechChunks("یک. ".repeat(400)).length > 1, true);
});

test("raw PCM becomes a playable WAV and parts join into one file", () => {
  const part = { mime: "audio/L16;codec=pcm;rate=24000", bytes: new Uint8Array(10).fill(1) };
  const wav = playable(part);
  assert.equal(wav.mime, "audio/wav");
  assert.deepEqual(readWav(wav.bytes), { rate: 24000, channels: 1, bits: 16, data: new Uint8Array(10).fill(1) });
  const joined = joinAudio([part, { mime: "audio/L16;rate=24000", bytes: new Uint8Array(6).fill(2) }]);
  assert.equal(joined.ext, "wav");
  assert.equal(readWav(joined.bytes)?.data.length, 16);
  const mp3 = joinAudio([{ mime: "audio/mpeg", bytes: new Uint8Array([1, 2]) }, { mime: "audio/mpeg", bytes: new Uint8Array([3]) }]);
  assert.deepEqual([mp3.ext, [...mp3.bytes]], ["mp3", [1, 2, 3]]);
});

test("targets: Gemini and OpenAI defaults, never Anthropic or OpenRouter", () => {
  const s = new Synthesizer(plugin([claude, openrouter, gemini, openai]) as never);
  assert.deepEqual(s.targets().map((t) => `${t.provider.id}|${t.model}`), [
    "g|gemini-3.8-flash-tts", "g|gemini-3.1-flash-tts-preview", "g|gemini-2.5-flash-preview-tts", "o|gpt-4o-mini-tts",
  ]);
  const picked = new Synthesizer(plugin([gemini, openai], ["o|tts-1", "g|my-tts"]) as never);
  assert.deepEqual(picked.targets().map((t) => t.model), ["tts-1", "my-tts"]);
});

test("gemini request asks for audio in the chosen voice", async () => {
  const s = new Synthesizer(plugin([gemini]) as never);
  const r = await s.synthesize("Hello");
  const req = stub.requests[0];
  assert.equal(req.url, "https://g/v1beta/models/gemini-3.8-flash-tts:generateContent");
  assert.deepEqual(JSON.parse(req.body ?? ""), {
    contents: [{ parts: [{ text: "Hello" }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
  });
  assert.equal(r.mime, "audio/L16;codec=pcm;rate=24000");
  assert.equal(r.bytes.length, 8);
});

test("openai request uses /audio/speech and returns the bytes", async () => {
  stub.respond = () => ({ status: 200, text: "", arrayBuffer: new Uint8Array([9, 9, 9]).buffer, headers: { "content-type": "audio/mpeg" } });
  const r = await new Synthesizer(plugin([openai]) as never).synthesize("Hi");
  assert.equal(stub.requests[0].url, "https://api.openai.com/v1/audio/speech");
  assert.deepEqual(JSON.parse(stub.requests[0].body ?? ""), { model: "gpt-4o-mini-tts", input: "Hi", voice: "alloy", response_format: "mp3" });
  assert.deepEqual([r.mime, [...r.bytes]], ["audio/mpeg", [9, 9, 9]]);
});

test("a per-minute quota is waited out on the same model, with a countdown", async () => {
  let calls = 0;
  stub.respond = () => (calls++ === 0 ? quota(false) : geminiAudio());
  const s = new Synthesizer(plugin([gemini]) as never);
  const waits: number[] = [];
  s.sleep = (ms) => {
    waits.push(ms);
    return Promise.resolve();
  };
  const phases: string[] = [];
  await s.synthesize("x", { onStatus: (st) => phases.push(st.phase) });
  assert.deepEqual(waits, [17500]);
  assert.deepEqual(phases, ["preparing", "waiting", "preparing"]);
  assert.deepEqual(stub.requests.map(modelOf), ["gemini-3.8-flash-tts", "gemini-3.8-flash-tts"]);
});

test("a per-day quota or a missing model moves on to the next model", async () => {
  stub.respond = (r) => {
    const m = modelOf(r);
    if (m === "gemini-3.8-flash-tts") return quota(true);
    if (m === "gemini-3.1-flash-tts-preview") return { status: 404, text: JSON.stringify({ error: { code: 404, message: "not found" } }) };
    return geminiAudio();
  };
  const r = await new Synthesizer(plugin([gemini]) as never).synthesize("x");
  assert.equal(r.model, "Gemini · gemini-2.5-flash-preview-tts");
  assert.deepEqual(quotaInfo(quota(true).text), { perDay: true, ms: 17000 });
});

test("when every model fails, the error lists each one", async () => {
  stub.respond = () => ({ status: 403, text: "<html><title>Error 403 (Forbidden)!!1</title></html>" });
  await assert.rejects(new Synthesizer(plugin([gemini]) as never).synthesize("x"), (e: { message: string; attempts: string[] }) =>
    /All 3 models failed/.test(e.message) && e.attempts.length === 3);
});

test("a failed part is retried from where it stopped, without remaking earlier parts", async () => {
  g.Audio = class {
    playbackRate = 1;
    onended: (() => void) | null = null;
    play() {
      setTimeout(() => this.onended?.(), 0);
      return Promise.resolve();
    }
    pause() {}
  };
  const text = "First sentence here. ".repeat(40) + "Second part. ".repeat(80);
  let fail = true;
  const made: string[] = [];
  stub.respond = (r) => {
    const t = (JSON.parse(r.body ?? "{}") as { contents: { parts: { text: string }[] }[] }).contents[0].parts[0].text;
    if (made.length === 1 && fail) return { status: 500, text: JSON.stringify({ error: { code: 500, message: "boom" } }) };
    made.push(t);
    return geminiAudio();
  };
  const p = plugin([gemini], ["g|only-tts"]);
  const speech = new SpeechController(p as never, new Synthesizer(p as never));
  const states: string[] = [];
  speech.onChange((s) => s && states.push(s.phase));
  const first = speech.speak(text, { id: "t" });
  await first.done;
  assert.equal(first.state.phase, "failed");
  assert.equal(first.state.part, 2);
  assert.equal(made.length, 1);
  fail = false;
  const again = speech.speak(text, { id: "t" });
  assert.equal(again, first);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(speech.state()?.phase, "done");
  assert.equal(made.length, first.state.total);
  assert.ok(states.includes("playing") && states.includes("failed"));
});
