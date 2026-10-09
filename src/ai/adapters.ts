import { ProviderType, ThinkingLevel } from "../types";

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
  parse(json: any): ParsedReply;
  streamEvent(json: any): StreamEvent;
  models(baseUrl: string, key: string): HttpRequest;
  parseModels(json: any): ModelInfo[];
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
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((c: any) => c.text ?? "").join("") : "";
    return {
      text,
      truncated: choice?.finish_reason === "length",
      blocked: choice?.finish_reason === "content_filter" ? "content filter" : "",
    };
  },
  streamEvent(json) {
    if (json.error) return { error: json };
    const choice = json.choices?.[0];
    const finish = choice?.finish_reason;
    return {
      text: typeof choice?.delta?.content === "string" ? choice.delta.content : "",
      truncated: finish === "length" || undefined,
      blocked: finish === "content_filter" ? "content filter" : undefined,
    };
  },
  models(baseUrl, key) {
    return { url: `${baseUrl}/models`, method: "GET", headers: bearer(key) };
  },
  parseModels(json) {
    return (json.data ?? []).map((m: any) => ({
      id: String(m.id),
      free: String(m.id).endsWith(":free") || (m.pricing?.prompt === "0" && m.pricing?.completion === "0"),
    }));
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
    return {
      text: (json.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""),
      truncated: json.stop_reason === "max_tokens",
      blocked: json.stop_reason === "refusal" ? "refusal" : "",
    };
  },
  streamEvent(json) {
    if (json.type === "error") return { error: json };
    if (json.type === "content_block_delta" && json.delta?.type === "text_delta") return { text: json.delta.text ?? "" };
    if (json.type === "message_delta") {
      const stop = json.delta?.stop_reason;
      return { truncated: stop === "max_tokens" || undefined, blocked: stop === "refusal" ? "refusal" : undefined };
    }
    return {};
  },
  models(baseUrl, key) {
    return { url: `${baseUrl}/models?limit=1000`, method: "GET", headers: { "x-api-key": key, ...ANTHROPIC_HEADERS } };
  },
  parseModels(json) {
    return (json.data ?? []).map((m: any) => ({ id: String(m.id), free: false }));
  },
};

const GEMINI_BUDGET: Record<string, number> = { off: 0, low: 1024, medium: 8192, high: 24576 };

function geminiThinking(model: string, level: ThinkingLevel): Record<string, unknown> {
  // Gemini 2.x takes a token budget; later models take a named level
  if (/gemini-2[.-]/.test(model)) return { thinkingBudget: GEMINI_BUDGET[level] };
  return { thinkingLevel: level === "off" ? "minimal" : level };
}

function geminiReply(json: any): ParsedReply {
  const cand = json.candidates?.[0];
  const finish = String(cand?.finishReason ?? "");
  return {
    text: (cand?.content?.parts ?? []).filter((x: any) => !x.thought).map((x: any) => x.text ?? "").join(""),
    truncated: finish === "MAX_TOKENS",
    blocked: json.promptFeedback?.blockReason
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
    if (json.error) return { error: json };
    const r = geminiReply(json);
    return { text: r.text, truncated: r.truncated || undefined, blocked: r.blocked || undefined };
  },
  models(baseUrl, key) {
    return { url: `${baseUrl}/models?pageSize=1000`, method: "GET", headers: { "x-goog-api-key": key } };
  },
  parseModels(json) {
    return (json.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m: any) => ({ id: String(m.name).replace(/^models\//, ""), free: false }));
  },
};

export const ADAPTERS: Record<ProviderType, Adapter> = { openai, anthropic, gemini };
