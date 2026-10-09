import type AiActionsPlugin from "../main";
import { Action, ThinkingLevel } from "../types";
import { AiError } from "./errors";

export type Vars = Record<string, unknown>;

export interface RunOptions {
  vars?: Vars | (() => Vars);
  model?: string;
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
  onProgress?: (status: string) => void;
  /** The answer so far while it streams; parts of a long text are shown one after another */
  onPartial?: (textSoFar: string) => void;
}

export interface RunResult {
  text: string;
  models: string[];
  truncated: boolean;
}

/**
 * {{name}} placeholders are filled from vars. A line whose placeholders (other than
 * {{text}}) are all empty is dropped, so optional context like "Title: {{title}}"
 * disappears cleanly. Without a {{text}} placeholder the text is appended.
 */
export function fillTemplate(template: string, vars: Vars, appendText: boolean): string {
  const value = (k: string) => (vars[k] == null ? "" : String(vars[k]));
  const keep = (line: string) => {
    const names = [...line.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).filter((k) => k !== "text");
    return !names.length || names.some((k) => value(k).trim());
  };
  let out = template.split("\n").filter(keep).join("\n").replace(/\{\{(\w+)\}\}/g, (_, k: string) => value(k));
  if (appendText && !/\{\{text\}\}/.test(template)) out = `${out}\n\n${value("text")}`.trim();
  return out;
}

export function splitText(text: string, max: number): string[] {
  if (!max || text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
    if (cut < max * 0.7) cut = window.lastIndexOf(" ");
    if (cut < max * 0.5) cut = max - 1;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

export async function runAction(plugin: AiActionsPlugin, action: Action, input: string, opts: RunOptions = {}): Promise<RunResult> {
  const text = String(input ?? "").trim();
  if (!text) throw new AiError("input", "There is no text to send.");

  const extra = typeof opts.vars === "function" ? opts.vars() : opts.vars ?? {};
  const vars: Vars = { language: plugin.settings.language, ...extra };
  const system = fillTemplate(action.system, vars, false);
  const model = opts.model || action.model;
  const say = opts.onProgress ?? (() => undefined);
  const models = new Set<string>();
  let truncated = false;

  const thinking = opts.thinking ?? action.thinking ?? "";
  let shownBefore = "";
  const ask = async (template: string, body: string, step: string) => {
    const r = await plugin.client.chat({
      system,
      prompt: fillTemplate(template, { ...vars, text: body }, true),
      model,
      thinking,
      signal: opts.signal,
      onProgress: (s) => say(step ? `${step} — ${s}` : s),
      onDelta: opts.onPartial ? (t) => opts.onPartial!(shownBefore + t) : undefined,
    });
    models.add(r.model);
    truncated = truncated || r.truncated;
    return r.text;
  };

  const chunks = splitText(text, Number(plugin.settings.chunkChars) || 0);
  let result: string;
  if (chunks.length === 1) {
    result = await ask(action.prompt, text, "");
  } else {
    const parts: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      shownBefore = parts.length ? `${parts.join("\n\n")}\n\n` : "";
      parts.push(await ask(action.prompt, chunks[i], `Part ${i + 1} of ${chunks.length}`));
    }
    shownBefore = "";
    result = action.mergePrompt.trim()
      ? await ask(action.mergePrompt, parts.join("\n\n---\n\n"), "Merging parts")
      : parts.join("\n\n");
  }
  return { text: result, models: [...models], truncated };
}
