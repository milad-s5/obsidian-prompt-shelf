import { Provider } from "../types";
import { ChatMessage, Media } from "./adapters";
import { AiError } from "./errors";

export type Capability = "images" | "audio";

export interface Needs {
  images?: boolean;
  audio?: boolean;
}

const DEFAULT_MATCH: Record<Capability, RegExp> = {
  images: /gemini|gpt-4o|gpt-4\.1|claude|vision/i,
  audio: /gemini|audio|voxtral/i,
};

export const MEDIA_LIMITS: Record<Capability, number> = {
  images: 8 * 1024 * 1024,
  audio: 15 * 1024 * 1024,
};

/** A model's own toggle wins; otherwise its name decides. Anthropic has no audio input at all. */
export function accepts(p: Provider, model: string, cap: Capability): boolean {
  const set = p.modelFlags?.[model]?.[cap];
  if (typeof set === "boolean") return set;
  if (cap === "audio" && p.type === "anthropic") return false;
  return DEFAULT_MATCH[cap].test(model);
}

export function fits(p: Provider, model: string, needs: Needs): boolean {
  return (!needs.images || accepts(p, model, "images")) && (!needs.audio || accepts(p, model, "audio"));
}

export function needsOf(messages: ChatMessage[] | undefined): Needs {
  return {
    images: Boolean(messages?.some((m) => m.images?.length)),
    audio: Boolean(messages?.some((m) => m.audio?.length)),
  };
}

const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);

/** Size is counted on the base64 text, which is what goes over the wire */
export function checkMediaSize(messages: ChatMessage[] | undefined): void {
  const total = (cap: Capability) => {
    let sum = 0;
    for (const m of messages ?? []) for (const x of (m[cap] ?? []) as Media<string>[]) sum += x.data.length;
    return sum;
  };
  for (const cap of ["images", "audio"] as const) {
    const size = total(cap);
    if (size > MEDIA_LIMITS[cap]) {
      throw new AiError("input", `The ${cap} in this request add up to ${mb(size)} MB; the limit is ${mb(MEDIA_LIMITS[cap])} MB. Downscale or compress them before sending.`);
    }
  }
}

export function noModelFor(needs: Needs): AiError {
  const what = needs.images && needs.audio ? "both images and audio" : needs.images ? "images" : "audio";
  return new AiError("setup", `No model that accepts ${what} is set up. In Prompt Shelf settings, turn on the matching input for a model that supports it, and make sure its provider has a key.`);
}
