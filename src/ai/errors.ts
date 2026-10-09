export type AiErrorKind =
  | "setup"
  | "input"
  | "auth"
  | "region"
  | "policy"
  | "quota"
  | "rate-limit"
  | "context"
  | "model"
  | "server"
  | "network"
  | "timeout"
  | "blocked"
  | "empty"
  | "request";

export class AiError extends Error {
  attempts: string[] = [];

  constructor(public kind: AiErrorKind, message: string, public detail = "") {
    super(message);
    this.name = "AiError";
  }
}

export function toAiError(err: unknown, label: string): AiError {
  if (err instanceof AiError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new AiError("request", `${label}: ${msg}`, msg);
}

export function combineFailures(failures: { label: string; error: AiError }[]): AiError {
  const first = failures[0].error;
  if (failures.length === 1) return first;
  const combined = new AiError(first.kind, `All ${failures.length} models failed. ${first.message}`, first.detail);
  combined.attempts = failures.map((f) => f.error.message);
  return combined;
}

function extractMessage(json: unknown): string {
  const root = (Array.isArray(json) ? json[0] : json) as Record<string, any> | null;
  if (!root || typeof root !== "object") return "";
  const parts: string[] = [];
  const e = root.error;
  if (typeof e === "string") parts.push(e);
  else if (e && typeof e === "object") {
    if (e.message) parts.push(String(e.message));
    if (e.metadata?.raw) parts.push(String(e.metadata.raw));
    if (e.status && !e.message) parts.push(String(e.status));
  }
  if (typeof root.message === "string") parts.push(root.message);
  if (typeof root.detail === "string") parts.push(root.detail);
  return parts.join(" — ");
}

export function httpError(status: number, json: unknown, raw: string, label: string): AiError {
  const detail = (extractMessage(json) || raw).trim().slice(0, 600);
  const d = detail.toLowerCase();
  const err = (kind: AiErrorKind, message: string) => new AiError(kind, message, `HTTP ${status}${detail ? `: ${detail}` : ""}`);

  if (/location is not supported|unsupported_country|unsupported country|not available in your (country|region)/.test(d))
    return err("region", `${label} is not available from your location. Connect through a VPN, or use another provider.`);
  if (/data policy|privacy settings/.test(d))
    return err("policy", `${label}: no endpoint for this model matches your account's privacy settings. On OpenRouter, allow free-model data use at openrouter.ai/settings/privacy, or pick another model.`);
  if (status === 401 || /api key not valid|api_key_invalid|invalid api key|incorrect api key|invalid x-api-key|no auth credentials/.test(d))
    return err("auth", `${label}: the API key was rejected. Check that it is correct and still active.`);
  if (status === 429) {
    if (/per.?day|daily|per.?month|quota|resource_exhausted/.test(d))
      return err("quota", `${label}: the usage quota is used up for now. Wait for it to reset, or use another model.`);
    return err("rate-limit", `${label} is rate limited right now. Wait a minute and try again, or use another model.`);
  }
  if (status === 402 || /insufficient|credit|balance|billing|payment required/.test(d))
    return err("quota", `${label}: the account is out of credit. Top it up, or use a free model.`);
  if (status === 413 || /context length|context window|too long|maximum.*tokens|token limit|too many tokens|request too large/.test(d))
    return err("context", `The text is too long for ${label}. Lower "Chunk size" in settings, or use a model with a larger context window.`);
  if (status === 404 || /no endpoints found|model.*(not found|does not exist|is not supported|unknown|not available)|invalid model/.test(d))
    return err("model", `${label}: this model was not found or is not available. Check its name with "Browse models" in settings.`);
  if (status === 403)
    return err("auth", `${label} refused the request. The key may not have access to this model.`);
  if (status >= 500)
    return err("server", `${label} is having trouble (HTTP ${status}). Try again shortly, or use another model.`);
  return err("request", `${label} rejected the request (HTTP ${status}).`);
}
