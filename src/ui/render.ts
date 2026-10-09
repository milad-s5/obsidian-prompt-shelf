import { Component, MarkdownRenderer, App } from "obsidian";
import { AiError } from "../ai/errors";
import { RunResult } from "../ai/runAction";

export async function renderResult(app: App, component: Component, el: HTMLElement, result: RunResult): Promise<void> {
  el.empty();
  const body = el.createDiv({ cls: "aia-result-body", attr: { dir: "auto" } });
  await MarkdownRenderer.render(app, result.text, body, "", component);
  if (result.truncated) {
    el.createDiv({ cls: "aia-warning", text: "The answer hit the output limit and is cut off." });
  }
  el.createDiv({ cls: "aia-muted aia-meta", text: `${result.models.join(", ")} · ${result.text.length} characters` });
}

export function renderError(el: HTMLElement, err: unknown): void {
  el.empty();
  const e = err instanceof AiError ? err : null;
  const box = el.createDiv({ cls: "aia-error" });
  box.createDiv({ text: e ? e.message : err instanceof Error ? err.message : String(err) });
  if (e?.attempts.length) {
    const list = box.createEl("ul");
    for (const a of e.attempts) list.createEl("li", { text: a });
  }
  if (e?.detail) {
    const details = box.createEl("details");
    details.createEl("summary", { text: "Details" });
    details.createEl("pre", { cls: "aia-detail", text: e.detail });
  }
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
