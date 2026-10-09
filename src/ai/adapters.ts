import { ProviderType, ThinkingLevel } from "../types";
import { arr, obj, str } from "./json";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatParams {
  system: string;
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  thinking?: ThinkingLevel;
  stream: boolean;
}

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
}

export interface ParsedReply {
  text: string;
  truncated: boolean;
  blocked: string;
}

export interface StreamEvent {
  text?: string;
  truncated?: boolean;
  blocked?: string;
  error?: unknown;
}

export interface ModelInfo {
  id: string;
  free: boolean;
}

export interface Adapter {
  chat(baseUrl: string, key: string, params: ChatParams): HttpRequest;
  parse(json: unknown): ParsedReply;
  streamEvent(json: unknown): StreamEvent;
  models(baseUrl: string, key: string): HttpRequest;
  parseModels(json: unknown): ModelInfo[];
}

const bearer = (key: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});

const openai: Adapter = {
  chat(baseUrl, key, p) {
    const body: Record<string, unknown> = {
      model: p.model,
      messages: p.system ? [{ role: "system", content: p.system }, ...p.messages] : p.messages,
    };
    // Reasoning models reject temperature and max_tokens, so both are sent only when asked for
    if (p.temperature != null) body.temperature = p.temperature;
    if (p.maxTokens) body.max_tokens = p.maxTokens;
    if (p.thinking) {
      if (/openrouter\.ai/i.test(baseUrl)) body.reasoning = { effort: p.thinking === "off" ? "none" : p.thinking };
      else body.reasoning_effort = p.thinking === "off" ? "minimal" : p.thinking;
    }
    if (p.stream) body.stream = true;
    return { url: `${baseUrl}/chat/completions`, method: "POST", headers: bearer(key), body };
  },
  parse(json) {
    const choice = obj(arr(obj(json).choices)[0]);
    const content = obj(choice.message).content;
    const text = Array.isArray(content) ? arr(content).map((c) => str(obj(c).text)).join("") : str(content);
    const finish = str(choice.finish_reason);
    return {
      text,
      truncated: finish === "length",
      blocked: finish === "content_filter" ? "content filter" : "",
    };
  },
  streamEvent(json) {
    if (obj(json).error) return { error: json };
    const choice = obj(arr(obj(json).choices)[0]);
    const finish = str(choice.finish_reason);
    return {
      text: str(obj(choice.delta).content),
      truncated: finish === "length" || undefined,
      blocked: finish === "content_filter" ? "content filter" : undefined,
    };
  },
  models(baseUrl, key) {
    return { url: `${baseUrl}/models`, method: "GET", headers: bearer(key) };
  },
  parseModels(json) {
    return arr(obj(json).data).map((raw) => {
      const m = obj(raw);
      const id = str(m.id);
      const pricing = obj(m.pricing);
      return { id, free: id.endsWith(":free") || (pricing.prompt === "0" && pricing.completion === "0") };
    });
  },
};

const ANTHROPIC_HEADERS = {
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true",
};

const ANTHROPIC_BUDGET: Record<string, number> = { low: 2048, medium: 8192, high: 24000 };

const anthropic: Adapter = {
  chat(baseUrl, key, p) {
    const budget = p.thinking ? ANTHROPIC_BUDGET[p.thinking] : undefined;
    const maxTokens = p.maxTokens ?? 16000;
    const body: Record<string, unknown> = {
      model: p.model,
      max_tokens: budget ? Math.max(maxTokens, budget + 4096) : maxTokens,
      messages: p.messages,
    };
    if (p.system) body.system = p.system;
    if (budget) body.thinking = { type: "enabled", budget_tokens: budget };
    else if (p.temperature != null) body.temperature = p.temperature;
    if (p.stream) body.stream = true;
    return { url: `${baseUrl}/messages`, method: "POST", headers: { "x-api-key": key, ...ANTHROPIC_HEADERS }, body };
  },
  parse(json) {
    const j = obj(json);
    const stop = str(j.stop_reason);
    return {
      text: arr(j.content).map(obj).filter((c) => c.type === "text").map((c) => str(c.text)).join(""),
      truncated: stop === "max_tokens",
      blocked: stop === "refusal" ? "refusal" : "",
    };
  },
  streamEvent(json) {
    const j = obj(json);
    const delta = obj(j.delta);
    if (j.type === "error") return { error: json };
    if (j.type === "content_block_delta" && delta.type === "text_delta") return { text: str(delta.text) };
    if (j.type === "message_delta") {
      const stop = str(delta.stop_reason);
      return { truncated: stop === "max_tokens" || undefined, blocked: stop === "refusal" ? "refusal" : undefined };
    }
    return {};
  },
  models(baseUrl, key) {
    return { url: `${baseUrl}/models?limit=1000`, method: "GET", headers: { "x-api-key": key, ...ANTHROPIC_HEADERS } };
  },
  parseModels(json) {
    return arr(obj(json).data).map((m) => ({ id: str(obj(m).id), free: false }));
  },
};

const GEMINI_BUDGET: Record<string, number> = { off: 0, low: 1024, medium: 8192, high: 24576 };

function geminiThinking(model: string, level: ThinkingLevel): Record<string, unknown> {
  // Gemini 2.x takes a token budget; later models take a named level
  if (/gemini-2[.-]/.test(model)) return { thinkingBudget: GEMINI_BUDGET[level] };
  return { thinkingLevel: level === "off" ? "minimal" : level };
}

function geminiReply(json: unknown): ParsedReply {
  const j = obj(json);
  const cand = obj(arr(j.candidates)[0]);
  const finish = str(cand.finishReason);
  return {
    text: arr(obj(cand.content).parts).map(obj).filter((x) => !x.thought).map((x) => str(x.text)).join(""),
    truncated: finish === "MAX_TOKENS",
    blocked: str(obj(j.promptFeedback).blockReason)
      || (/SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(finish) ? finish.toLowerCase() : ""),
  };
}

const gemini: Adapter = {
  chat(baseUrl, key, p) {
    const model = p.model.replace(/^models\//, "");
    const body: Record<string, unknown> = {
      contents: p.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    };
    if (p.system) body.systemInstruction = { parts: [{ text: p.system }] };
    const config: Record<string, unknown> = {};
    if (p.temperature != null) config.temperature = p.temperature;
    if (p.maxTokens) config.maxOutputTokens = p.maxTokens;
    if (p.thinking) config.thinkingConfig = geminiThinking(model, p.thinking);
    if (Object.keys(config).length) body.generationConfig = config;
    const url = p.stream
      ? `${baseUrl}/models/${model}:streamGenerateContent?alt=sse`
      : `${baseUrl}/models/${model}:generateContent`;
    return { url, method: "POST", headers: { "x-goog-api-key": key }, body };
  },
  parse: geminiReply,
  streamEvent(json) {
    if (obj(json).error) return { error: json };
    const r = geminiReply(json);
    return { text: r.text, truncated: r.truncated || undefined, blocked: r.blocked || undefined };
  },
  models(baseUrl, key) {
    return { url: `${baseUrl}/models?pageSize=1000`, method: "GET", headers: { "x-goog-api-key": key } };
  },
  parseModels(json) {
    return arr(obj(json).models)
      .map(obj)
      .filter((m) => arr(m.supportedGenerationMethods).includes("generateContent"))
      .map((m) => ({ id: str(m.name).replace(/^models\//, ""), free: false }));
  },
};

export const ADAPTERS: Record<ProviderType, Adapter> = { openai, anthropic, gemini };
