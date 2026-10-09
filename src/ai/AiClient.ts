import { requestUrl, RequestUrlResponse } from "obsidian";
import type AiActionsPlugin from "../main";
import { Provider } from "../types";
import { ADAPTERS, ChatMessage, HttpRequest, ModelInfo } from "./adapters";
import { AiError, combineFailures, httpError, toAiError } from "./errors";

export interface ChatRequest {
  prompt?: string;
  messages?: ChatMessage[];
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  onProgress?: (status: string) => void;
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
  const i = (ref ?? "").indexOf("|");
  if (i <= 0) return null;
  return { providerId: ref!.slice(0, i), model: ref!.slice(i + 1) };
}

const trimSlash = (s: string): string => s.trim().replace(/\/+$/, "");

const isLocal = (url: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url.trim());

export class AiClient {
  constructor(private plugin: AiActionsPlugin) {}

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
    const provider = r && this.plugin.settings.providers.find((p) => p.id === r.providerId);
    return provider && r!.model ? { provider, model: r!.model } : null;
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
      throw new AiError("setup", "No model is set up yet. Add a provider, its API key and a model in AI Actions settings.");
    }
    const failures: { label: string; error: AiError }[] = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      try {
        req.onProgress?.(failures.length
          ? `${failures[failures.length - 1].label} failed — trying ${this.label(t)}…`
          : `Waiting for ${this.label(t)}…`);
        return await this.chatWith(t, req);
      } catch (e) {
        const error = toAiError(e, this.label(t));
        console.warn("[ai-actions]", this.label(t), error.message, error.detail);
        failures.push({ label: this.label(t), error });
      }
    }
    throw combineFailures(failures);
  }

  async chatWith(t: Target, req: ChatRequest): Promise<ChatResult> {
    const label = this.label(t);
    const baseUrl = trimSlash(t.provider.baseUrl);
    if (!baseUrl) throw new AiError("setup", `${t.provider.name} has no Base URL. Set it in AI Actions settings.`);
    const key = this.plugin.keys.get(t.provider.id);
    if (!key && !isLocal(baseUrl)) {
      throw new AiError("setup", `No API key saved for ${t.provider.name}. Add it in AI Actions settings.`);
    }
    const adapter = ADAPTERS[t.provider.type] ?? ADAPTERS.openai;
    const maxTokens = req.maxTokens ?? (t.provider.type === "anthropic" ? this.plugin.settings.maxTokens : undefined);
    const http = adapter.chat(baseUrl, key, {
      system: req.system ?? "",
      messages: req.messages ?? [{ role: "user", content: req.prompt ?? "" }],
      model: t.model,
      temperature: req.temperature,
      maxTokens,
    });
    const reply = adapter.parse(await this.send(http, label));
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

  private async send(req: HttpRequest, label: string): Promise<any> {
    const seconds = this.plugin.settings.timeoutSec || 180;
    let res: RequestUrlResponse;
    try {
      res = await withTimeout(
        requestUrl({
          url: req.url,
          method: req.method,
          headers: req.headers,
          throw: false,
          ...(req.body !== undefined ? { contentType: "application/json", body: JSON.stringify(req.body) } : {}),
        }),
        seconds * 1000,
        () => new AiError("timeout", `${label} did not answer within ${seconds} seconds. Try again, raise the timeout in settings, or use a faster model.`)
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
    let json: any = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }

    if (res.status < 200 || res.status >= 300) throw httpError(res.status, json, raw, label);
    if (json?.error) {
      const code = Number(json.error.code);
      throw httpError(code >= 400 && code < 600 ? code : 400, json, raw, label);
    }
    if (json === null) {
      throw new AiError("request", `${label} sent back something that is not JSON. Check the provider's Base URL.`, raw.slice(0, 600));
    }
    return json;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: number;
  return Promise.race([
    promise.finally(() => window.clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = window.setTimeout(() => reject(onTimeout()), ms);
    }),
  ]);
}
