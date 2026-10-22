import { requestUrl, RequestUrlResponse } from "obsidian";
import type PromptShelfPlugin from "../main";
import { AiError, combineFailures, httpError } from "../ai/errors";
import { arr, obj, parseJson, str } from "../ai/json";
import { makeRef, parseRef } from "../ai/AiClient";
import { Provider } from "../types";
import { AudioPart, base64ToBytes } from "./audio";

export type SpeechProviderType = "gemini" | "openai";

/** Tried in order when no speech models are picked in settings */
export const DEFAULT_SPEECH_MODELS: Record<SpeechProviderType, string[]> = {
  gemini: ["gemini-3.8-flash-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"],
  openai: ["gpt-4o-mini-tts"],
};

export const DEFAULT_VOICES: Record<SpeechProviderType, string> = { gemini: "Kore", openai: "alloy" };

const MAX_MINUTE_RETRIES = 3;

export interface SpeechTarget {
  provider: Provider;
  model: string;
}

export interface SynthStatus {
  phase: "preparing" | "waiting";
  model: string;
  /** When a quota wait ends */
  until: number;
}

export interface SynthOptions {
  signal?: AbortSignal;
  onStatus?: (s: SynthStatus) => void;
}

export interface SynthResult extends AudioPart {
  model: string;
}

const trimSlash = (s: string) => s.trim().replace(/\/+$/, "");
const stopped = () => new AiError("aborted", "Stopped.");

/** Gemini's 429 says whether the per-minute or the per-day quota ran out, and how long to wait */
export function quotaInfo(raw: string): { perDay: boolean; ms: number | null } {
  const details = arr(obj(obj(parseJson(raw)).error).details).map(obj);
  const delay = str(details.find((d) => /RetryInfo/.test(str(d["@type"])))?.retryDelay);
  const perDay = details.some((d) => arr(d.violations).some((v) => /PerDay/i.test(str(obj(v).quotaId))));
  return { perDay, ms: delay ? parseFloat(delay) * 1000 : null };
}

export class Synthesizer {
  /** The model that worked last is tried first */
  private working = "";

  /** Replaced in tests so quota waits do not take real time */
  sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = window.setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        window.clearTimeout(timer);
        reject(stopped());
      });
    });

  constructor(private plugin: PromptShelfPlugin) {}

  label(t: SpeechTarget): string {
    return `${t.provider.name} · ${t.model}`;
  }

  private usable(p: Provider): boolean {
    return p.type !== "anthropic" && this.plugin.client.usable(p);
  }

  targets(): SpeechTarget[] {
    const s = this.plugin.settings;
    const providers = s.providers.filter((p) => this.usable(p));
    let targets: SpeechTarget[];
    if (s.speechModels.length) {
      targets = s.speechModels
        .map((ref) => {
          const r = parseRef(ref);
          const provider = r && providers.find((p) => p.id === r.providerId);
          return provider && r ? { provider, model: r.model } : null;
        })
        .filter((t): t is SpeechTarget => t !== null);
    } else {
      targets = providers
        .filter((p) => p.type === "gemini" || /api\.openai\.com/i.test(p.baseUrl))
        .flatMap((p) => DEFAULT_SPEECH_MODELS[p.type as SpeechProviderType].map((model) => ({ provider: p, model })));
    }
    const i = targets.findIndex((t) => makeRef(t.provider.id, t.model) === this.working);
    return i > 0 ? [targets[i], ...targets.slice(0, i), ...targets.slice(i + 1)] : targets;
  }

  async synthesize(text: string, opts: SynthOptions = {}): Promise<SynthResult> {
    const targets = this.targets();
    if (!targets.length) {
      throw new AiError("setup", "No speech model is set up. Add a Gemini provider with a key, or pick speech models under Read aloud in Prompt Shelf settings.");
    }
    const failures: { label: string; error: AiError }[] = [];
    for (const t of targets) {
      const label = this.label(t);
      for (let attempt = 0; attempt <= MAX_MINUTE_RETRIES; attempt++) {
        if (opts.signal?.aborted) throw stopped();
        opts.onStatus?.({ phase: "preparing", model: label, until: 0 });
        const res = await this.request(t, text, label, opts.signal);
        if (res.status === 429) {
          const raw = safeText(res);
          const q = quotaInfo(raw);
          if (q.perDay || attempt === MAX_MINUTE_RETRIES) {
            failures.push({ label, error: httpError(429, parseJson(raw), raw, label) });
            break;
          }
          const wait = Math.min(q.ms ?? 20000, 65000) + 500;
          opts.onStatus?.({ phase: "waiting", model: label, until: Date.now() + wait });
          await this.sleep(wait, opts.signal);
          continue;
        }
        if (res.status < 200 || res.status >= 300) {
          const raw = safeText(res);
          failures.push({ label, error: httpError(res.status, parseJson(raw), raw, label) });
          break;
        }
        const part = this.audioOf(t, res);
        if (!part) {
          failures.push({ label, error: new AiError("empty", `${label} returned no audio.`) });
          break;
        }
        this.working = makeRef(t.provider.id, t.model);
        return { ...part, model: label };
      }
    }
    throw combineFailures(failures);
  }

  private async request(t: SpeechTarget, text: string, label: string, signal?: AbortSignal): Promise<RequestUrlResponse> {
    const s = this.plugin.settings;
    const type = t.provider.type as SpeechProviderType;
    const voice = s.speechVoice.trim() || DEFAULT_VOICES[type];
    const base = trimSlash(t.provider.baseUrl);
    const key = this.plugin.keys.get(t.provider.id);
    const req: { url: string; headers: Record<string, string>; body: unknown } = type === "gemini"
      ? {
        url: `${base}/models/${t.model}:generateContent`,
        headers: { "x-goog-api-key": key },
        body: {
          contents: [{ parts: [{ text }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
        },
      }
      : {
        url: `${base}/audio/speech`,
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        body: { model: t.model, input: text, voice, response_format: "mp3" },
      };
    const seconds = s.timeoutSec || 180;
    try {
      return await abortable(
        requestUrl({ url: req.url, method: "POST", headers: req.headers, contentType: "application/json", body: JSON.stringify(req.body), throw: false }),
        seconds * 1000,
        () => new AiError("timeout", `${label} did not make the audio within ${seconds} seconds. Try again, or raise the timeout in settings.`),
        signal
      );
    } catch (e) {
      if (e instanceof AiError) throw e;
      throw new AiError("network", `Could not reach ${label}. Check your internet connection, VPN, or the provider's Base URL.`, e instanceof Error ? e.message : String(e));
    }
  }

  private audioOf(t: SpeechTarget, res: RequestUrlResponse): AudioPart | null {
    if (t.provider.type !== "gemini") {
      const bytes = new Uint8Array(res.arrayBuffer);
      return bytes.length ? { mime: res.headers["content-type"] || "audio/mpeg", bytes } : null;
    }
    const parts = arr(obj(obj(arr(obj(parseJson(safeText(res))).candidates)[0]).content).parts).map(obj);
    for (const p of parts) {
      const inline = obj(p.inlineData ?? p.inline_data);
      const data = str(inline.data);
      if (data) return { mime: str(inline.mimeType ?? inline.mime_type), bytes: base64ToBytes(data) };
    }
    return null;
  }
}

function safeText(res: RequestUrlResponse): string {
  try {
    return res.text ?? "";
  } catch {
    return "";
  }
}

function abortable<T>(promise: Promise<T>, ms: number, onTimeout: () => Error, signal?: AbortSignal): Promise<T> {
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
