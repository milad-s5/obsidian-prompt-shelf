import { requestUrl, RequestUrlResponse } from "obsidian";
import type PromptShelfPlugin from "../main";
import { Provider, ThinkingLevel } from "../types";
import { ADAPTERS, Adapter, ChatMessage, HttpRequest, ModelInfo, ParsedReply } from "./adapters";
import { AiError, combineFailures, httpError, toAiError } from "./errors";
import { obj, parseJson, str } from "./json";

export interface ChatRequest {
  prompt?: string;
  messages?: ChatMessage[];
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
  onProgress?: (status: string) => void;
  /** Receives the answer so far while it streams */
  onDelta?: (textSoFar: string) => void;
}

export interface ChatResult {
  text: string;
  model: string;
  truncated: boolean;
}

export interface Target {
  provider: Provider;
  model: string;
}

export interface ModelOption {
  ref: string;
  label: string;
}

export const makeRef = (providerId: string, model: string): string => `${providerId}|${model}`;

export function parseRef(ref: string | undefined): { providerId: string; model: string } | null {
  if (!ref) return null;
  const i = ref.indexOf("|");
  if (i <= 0) return null;
  return { providerId: ref.slice(0, i), model: ref.slice(i + 1) };
}

const trimSlash = (s: string): string => s.trim().replace(/\/+$/, "");

const isLocal = (url: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url.trim());

const stopped = () => new AiError("aborted", "Stopped.");

export class AiClient {
  constructor(private plugin: PromptShelfPlugin) {}

  label(t: Target): string {
    return `${t.provider.name} · ${t.model}`;
  }

  modelOptions(): ModelOption[] {
    return this.plugin.settings.providers.flatMap((p) =>
      p.models.map((m) => ({ ref: makeRef(p.id, m), label: `${p.name} · ${m}` }))
    );
  }

  resolve(ref: string | undefined): Target | null {
    const r = parseRef(ref);
    if (!r?.model) return null;
    const provider = this.plugin.settings.providers.find((p) => p.id === r.providerId);
    return provider ? { provider, model: r.model } : null;
  }

  /** The requested model, then the default, then the fallbacks, without repeats */
  candidates(ref?: string): Target[] {
    const s = this.plugin.settings;
    const refs = [ref, s.defaultModel, ...s.fallbackModels].filter((r): r is string => Boolean(r));
    const targets = [...new Set(refs)].map((r) => this.resolve(r)).filter((t): t is Target => t !== null);
    if (targets.length) return targets;
    const p = s.providers.find((p) => p.models.length && (this.plugin.keys.has(p.id) || isLocal(p.baseUrl)));
    return p ? [{ provider: p, model: p.models[0] }] : [];
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const targets = this.candidates(req.model);
    if (!targets.length) {
      throw new AiError("setup", "No model is set up yet. Add a provider, its API key and a model in Prompt Shelf settings.");
    }
    const failures: { label: string; error: AiError }[] = [];
    for (const t of targets) {
      if (req.signal?.aborted) throw stopped();
      try {
        req.onProgress?.(failures.length
          ? `${failures[failures.length - 1].label} failed — trying ${this.label(t)}…`
          : `Waiting for ${this.label(t)}…`);
        return await this.chatWith(t, req);
      } catch (e) {
        const error = toAiError(e, this.label(t));
        if (error.kind === "aborted") throw error;
        console.warn("[prompt-shelf]", this.label(t), error.message, error.detail);
        failures.push({ label: this.label(t), error });
        req.onDelta?.("");
      }
    }
    throw combineFailures(failures);
  }

  async chatWith(t: Target, req: ChatRequest): Promise<ChatResult> {
    const label = this.label(t);
    const baseUrl = trimSlash(t.provider.baseUrl);
    if (!baseUrl) throw new AiError("setup", `${t.provider.name} has no Base URL. Set it in Prompt Shelf settings.`);
    const key = this.plugin.keys.get(t.provider.id);
    if (!key && !isLocal(baseUrl)) {
      throw new AiError("setup", `No API key saved for ${t.provider.name}. Add it in Prompt Shelf settings.`);
    }
    const adapter = ADAPTERS[t.provider.type] ?? ADAPTERS.openai;
    const build = (stream: boolean) => adapter.chat(baseUrl, key, {
      system: req.system ?? "",
      messages: req.messages ?? [{ role: "user", content: req.prompt ?? "" }],
      model: t.model,
      temperature: req.temperature,
      maxTokens: req.maxTokens ?? (t.provider.type === "anthropic" ? this.plugin.settings.maxTokens : undefined),
      thinking: req.thinking,
      stream,
    });

    let reply: ParsedReply | null = null;
    if (req.onDelta && this.plugin.settings.streaming) {
      reply = await this.stream(build(true), adapter, label, req);
    }
    if (!reply) reply = adapter.parse(await this.send(build(false), label, req.signal));

    if (reply.blocked) throw new AiError("blocked", `${label} refused to answer (${reply.blocked}).`);
    if (!reply.text.trim()) {
      throw new AiError("empty", reply.truncated
        ? `${label} used its whole output limit before writing an answer. Raise "Max output tokens" or use another model.`
        : `${label} returned an empty answer.`);
    }
    return { text: reply.text, model: label, truncated: reply.truncated };
  }

  async listModels(p: Provider): Promise<ModelInfo[]> {
    const baseUrl = trimSlash(p.baseUrl);
    if (!baseUrl) throw new AiError("setup", `${p.name} has no Base URL.`);
    const key = this.plugin.keys.get(p.id);
    if (!key && !isLocal(baseUrl)) throw new AiError("setup", `Save an API key for ${p.name} first.`);
    const adapter = ADAPTERS[p.type] ?? ADAPTERS.openai;
    const models = adapter.parseModels(await this.send(adapter.models(baseUrl, key), p.name));
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Streams over fetch. Returns null when fetch cannot reach the provider at all —
   * usually CORS, which requestUrl does not have — so the caller retries without streaming.
   */
  private async stream(req: HttpRequest, adapter: Adapter, label: string, chat: ChatRequest): Promise<ParsedReply | null> {
    const seconds = this.plugin.settings.timeoutSec || 180;
    const controller = new AbortController();
    let timedOut = false;
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, seconds * 1000);
    };
    const onStop = () => controller.abort();
    chat.signal?.addEventListener("abort", onStop);

    const fail = (e: unknown): never => {
      if (chat.signal?.aborted) throw stopped();
      if (timedOut) throw new AiError("timeout", `${label} stopped sending for ${seconds} seconds. Try again, raise the timeout in settings, or use a faster model.`);
      if (e instanceof AiError) throw e;
      throw new AiError("network", `The connection to ${label} broke off. Check your internet connection or VPN.`, e instanceof Error ? e.message : String(e));
    };

    let res: Response;
    try {
      arm();
      res = await fetch(req.url, {
        method: req.method,
        headers: { ...req.headers, "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });
    } catch (e) {
      window.clearTimeout(timer);
      chat.signal?.removeEventListener("abort", onStop);
      if (chat.signal?.aborted) throw stopped();
      if (timedOut) return fail(e);
      return null;
    }

    try {
      if (!res.ok) {
        const raw = await res.text();
        throw httpError(res.status, parseJson(raw), raw, label);
      }
      if (!(res.headers.get("content-type") ?? "").includes("event-stream") || !res.body) {
        const raw = await res.text();
        const json = parseJson(raw);
        if (json === undefined) throw new AiError("request", `${label} sent back something that is not JSON. Check the provider's Base URL.`, raw.slice(0, 600));
        if (obj(json).error) throw httpError(errorStatus(json), json, raw, label);
        return adapter.parse(json);
      }

      const reply: ParsedReply = { text: "", truncated: false, blocked: "" };
      const reader = res.body.getReader();
      controller.signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined));
      const decoder = new TextDecoder();
      let buffer = "";
      let data: string[] = [];
      const flush = () => {
        if (!data.length) return;
        const payload = data.join("\n");
        data = [];
        if (payload === "[DONE]") return;
        const json = parseJson(payload);
        if (json === undefined) return;
        const ev = adapter.streamEvent(json);
        if (ev.error) throw httpError(errorStatus(ev.error), ev.error, payload, label);
        if (ev.truncated) reply.truncated = true;
        if (ev.blocked) reply.blocked = ev.blocked;
        if (ev.text) {
          reply.text += ev.text;
          chat.onDelta?.(reply.text);
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (line === "") flush();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (controller.signal.aborted) return fail(new Error("Aborted"));
      if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
      flush();
      return reply;
    } catch (e) {
      return fail(e);
    } finally {
      window.clearTimeout(timer);
      chat.signal?.removeEventListener("abort", onStop);
    }
  }

  private async send(req: HttpRequest, label: string, signal?: AbortSignal): Promise<unknown> {
    const seconds = this.plugin.settings.timeoutSec || 180;
    let res: RequestUrlResponse;
    try {
      res = await race(
        requestUrl({
          url: req.url,
          method: req.method,
          headers: req.headers,
          throw: false,
          ...(req.body !== undefined ? { contentType: "application/json", body: JSON.stringify(req.body) } : {}),
        }),
        seconds * 1000,
        () => new AiError("timeout", `${label} did not answer within ${seconds} seconds. Try again, raise the timeout in settings, or use a faster model.`),
        signal
      );
    } catch (e) {
      if (e instanceof AiError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new AiError("network", `Could not reach ${label}. Check your internet connection, VPN, or the provider's Base URL.`, msg);
    }

    let raw = "";
    try {
      raw = res.text ?? "";
    } catch {
      raw = "";
    }
    const json = parseJson(raw);
    if (res.status < 200 || res.status >= 300) throw httpError(res.status, json, raw, label);
    if (obj(json).error) throw httpError(errorStatus(json), json, raw, label);
    if (json === undefined) {
      throw new AiError("request", `${label} sent back something that is not JSON. Check the provider's Base URL.`, raw.slice(0, 600));
    }
    return json;
  }
}

function errorStatus(json: unknown): number {
  const root = obj(json);
  const e = root.error === undefined ? root : obj(root.error);
  const code = Number(e.code ?? e.status);
  if (code >= 400 && code < 600) return code;
  if (/overloaded/i.test(str(e.type))) return 529;
  if (/rate_limit/i.test(str(e.type))) return 429;
  return 400;
}

function race<T>(promise: Promise<T>, ms: number, onTimeout: () => Error, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(stopped());
  let timer = 0;
  let onStop = () => undefined as void;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = window.setTimeout(() => reject(onTimeout()), ms);
      onStop = () => reject(stopped());
      signal?.addEventListener("abort", onStop);
    }),
  ]).finally(() => {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", onStop);
  });
}
