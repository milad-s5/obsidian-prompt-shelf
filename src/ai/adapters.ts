import { ProviderType } from "../types";

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

export interface ModelInfo {
  id: string;
  free: boolean;
}

export interface Adapter {
  chat(baseUrl: string, key: string, params: ChatParams): HttpRequest;
  parse(json: any): ParsedReply;
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

const ANTHROPIC_VERSION = "2023-06-01";

const anthropic: Adapter = {
  chat(baseUrl, key, p) {
    const body: Record<string, unknown> = { model: p.model, max_tokens: p.maxTokens, messages: p.messages };
    if (p.system) body.system = p.system;
    if (p.temperature != null) body.temperature = p.temperature;
    return {
      url: `${baseUrl}/messages`,
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
      body,
    };
  },
  parse(json) {
    return {
      text: (json.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""),
      truncated: json.stop_reason === "max_tokens",
      blocked: json.stop_reason === "refusal" ? "refusal" : "",
    };
  },
  models(baseUrl, key) {
    return {
      url: `${baseUrl}/models?limit=1000`,
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
    };
  },
  parseModels(json) {
    return (json.data ?? []).map((m: any) => ({ id: String(m.id), free: false }));
  },
};

const gemini: Adapter = {
  chat(baseUrl, key, p) {
    const body: Record<string, unknown> = {
      contents: p.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    };
    if (p.system) body.systemInstruction = { parts: [{ text: p.system }] };
    const config: Record<string, unknown> = {};
    if (p.temperature != null) config.temperature = p.temperature;
    if (p.maxTokens) config.maxOutputTokens = p.maxTokens;
    if (Object.keys(config).length) body.generationConfig = config;
    return {
      url: `${baseUrl}/models/${p.model.replace(/^models\//, "")}:generateContent`,
      method: "POST",
      headers: { "x-goog-api-key": key },
      body,
    };
  },
  parse(json) {
    const cand = json.candidates?.[0];
    const finish = String(cand?.finishReason ?? "");
    return {
      text: (cand?.content?.parts ?? []).filter((x: any) => !x.thought).map((x: any) => x.text ?? "").join(""),
      truncated: finish === "MAX_TOKENS",
      blocked: json.promptFeedback?.blockReason
        || (/SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(finish) ? finish.toLowerCase() : ""),
    };
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
