import { App, Component, MarkdownRenderer } from "obsidian";
import { AiError } from "../ai/errors";
import { RunResult } from "../ai/runAction";

const STREAM_RENDER_MS = 150;

/** Each output element owns one component, replaced on every render so nothing outlives it */
const owners = new WeakMap<HTMLElement, Component>();

function freshComponent(el: HTMLElement): Component {
  owners.get(el)?.unload();
  const component = new Component();
  component.load();
  owners.set(el, component);
  return component;
}

export function releaseOutput(el: HTMLElement): void {
  owners.get(el)?.unload();
  owners.delete(el);
}

export async function renderResult(app: App, el: HTMLElement, result: RunResult): Promise<void> {
  el.empty();
  const body = el.createDiv({ cls: "psh-result-body", attr: { dir: "auto" } });
  await MarkdownRenderer.render(app, result.text, body, "", freshComponent(el));
  if (result.truncated) {
    el.createDiv({ cls: "psh-warning", text: "The answer hit the output limit and is cut off." });
  }
  el.createDiv({ cls: "psh-muted psh-meta", text: `${result.models.join(", ")} · ${result.text.length} characters` });
}

/** Renders a streaming answer as markdown, at most a few times a second */
export class StreamView {
  private latest = "";
  private timer = 0;
  private body: HTMLElement | null = null;
  private stopped = false;

  constructor(private app: App, private el: HTMLElement) {}

  update(text: string): void {
    this.latest = text;
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      void this.paint();
    }, STREAM_RENDER_MS);
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.timer = 0;
  }

  private async paint(): Promise<void> {
    if (this.stopped) return;
    if (!this.body || !this.el.contains(this.body)) {
      this.el.empty();
      this.body = this.el.createDiv({ cls: "psh-result-body psh-streaming", attr: { dir: "auto" } });
    }
    const next = createDiv();
    await MarkdownRenderer.render(this.app, this.latest, next, "", freshComponent(this.el));
    if (this.stopped) return;
    this.body.replaceChildren(...Array.from(next.childNodes));
    this.body.scrollTop = this.body.scrollHeight;
  }
}

export function renderError(el: HTMLElement, err: unknown): void {
  el.empty();
  const e = err instanceof AiError ? err : null;
  const box = el.createDiv({ cls: "psh-error" });
  box.createDiv({ text: e ? e.message : err instanceof Error ? err.message : String(err) });
  if (e?.attempts.length) {
    const list = box.createEl("ul");
    for (const a of e.attempts) list.createEl("li", { text: a });
  }
  if (e?.detail) {
    const details = box.createEl("details");
    details.createEl("summary", { text: "Details" });
    details.createEl("pre", { cls: "psh-detail", text: e.detail });
  }
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
