import { Notice } from "obsidian";
import type AiActionsPlugin from "../main";
import { RunResult, Vars, runAction } from "../ai/runAction";
import { Action } from "../types";
import { copyText, renderError, renderResult } from "./render";

export interface PanelOptions {
  /** Remembers the chosen action and model per panel */
  id?: string;
  title?: string;
  getText: () => string;
  /** Results are cached per key, so switching items and back shows the earlier answer */
  getKey?: () => string | null | undefined;
  vars?: Vars | (() => Vars);
  defaultAction?: string;
  actions?: string[];
  onResult?: (text: string, action: Action) => void;
}

export class ActionPanel {
  readonly el: HTMLElement;
  private actionSelect: HTMLSelectElement;
  private modelSelect: HTMLSelectElement;
  private runButton: HTMLButtonElement;
  private copyButton: HTMLButtonElement;
  private status: HTMLElement;
  private output: HTMLElement;
  private id: string;
  private actionId: string;
  private model: string;
  private running: string | null = null;
  private shown: string | null = null;
  private failures = new Map<string, unknown>();

  constructor(private plugin: AiActionsPlugin, el: HTMLElement, private opts: PanelOptions) {
    this.el = el;
    this.id = opts.id ?? "default";
    const saved = plugin.settings.panels[this.id];
    this.actionId = saved?.action || opts.defaultAction || "";
    this.model = saved?.model ?? "";

    el.addClass("aia-panel");
    const row = el.createDiv({ cls: "aia-row" });
    row.createSpan({ cls: "aia-title", text: opts.title ?? "AI" });
    this.actionSelect = row.createEl("select", { cls: "dropdown" });
    this.actionSelect.onchange = () => {
      this.actionId = this.actionSelect.value;
      this.remember();
      this.refresh();
    };
    this.modelSelect = row.createEl("select", { cls: "dropdown" });
    this.modelSelect.onchange = () => {
      this.model = this.modelSelect.value;
      this.remember();
      this.refresh();
    };
    this.runButton = row.createEl("button", { cls: "mod-cta", text: "Run" });
    this.runButton.onclick = () => void this.run();
    this.copyButton = row.createEl("button", { text: "Copy" });
    this.copyButton.onclick = () => void this.copy();
    const gear = row.createEl("button", { text: "Settings" });
    gear.onclick = () => plugin.openSettings();
    this.status = el.createDiv({ cls: "aia-muted aia-status" });
    this.output = el.createDiv({ cls: "aia-output" });

    plugin.panels.add(this);
    this.refresh();
  }

  private get actions(): Action[] {
    const all = this.plugin.settings.actions;
    return this.opts.actions ? all.filter((a) => this.opts.actions!.includes(a.id)) : all;
  }

  private get action(): Action | undefined {
    return this.actions.find((a) => a.id === this.actionId) ?? this.actions[0];
  }

  private resultKey(): string | null {
    const item = this.opts.getKey ? this.opts.getKey() : "";
    if (item === null || item === undefined) return null;
    return `${this.id}|${item}|${this.action?.id}|${this.model}`;
  }

  private remember(): void {
    this.plugin.settings.panels[this.id] = { action: this.actionId, model: this.model };
    void this.plugin.saveData(this.plugin.settings);
  }

  refresh(): void {
    const action = this.action;
    this.actionSelect.empty();
    for (const a of this.actions) this.actionSelect.createEl("option", { value: a.id, text: a.name });
    if (action) this.actionSelect.value = action.id;

    const options = this.plugin.client.modelOptions();
    if (this.model && !options.some((o) => o.ref === this.model)) this.model = "";
    this.modelSelect.empty();
    this.modelSelect.createEl("option", { value: "", text: "Default model" });
    for (const o of options) this.modelSelect.createEl("option", { value: o.ref, text: o.label });
    this.modelSelect.value = this.model;

    const key = this.resultKey();
    const busy = key !== null && this.running === key;
    const ready = this.plugin.client.candidates(this.model || action?.model).length > 0;
    const hasText = key !== null && Boolean(this.opts.getText().trim());
    const result = key ? this.plugin.results.get(key) : undefined;
    const failure = key ? this.failures.get(key) : undefined;

    this.runButton.disabled = busy || this.running !== null || !ready || !hasText || !action;
    this.runButton.setText(result ? "Run again" : "Run");
    this.copyButton.disabled = !result;
    if (!busy) {
      this.status.setText(!ready ? "No model is set up yet — open Settings to add a provider and key."
        : !hasText ? "No text to send yet." : this.running ? "Another run is in progress…" : "");
    }

    const shown = busy ? "busy" : result ? `ok:${key}` : failure ? `err:${key}` : "";
    if (shown === this.shown) return;
    this.shown = shown;
    this.output.empty();
    if (result) void renderResult(this.plugin.app, this.plugin, this.output, result);
    else if (failure) renderError(this.output, failure);
    this.output.toggleClass("aia-hidden", !result && !failure);
  }

  async run(): Promise<void> {
    const action = this.action;
    const key = this.resultKey();
    if (!action || key === null || this.running) return;
    this.running = key;
    this.failures.delete(key);
    this.refresh();
    const started = Date.now();
    try {
      const result: RunResult = await runAction(this.plugin, action, this.opts.getText(), {
        vars: this.opts.vars,
        model: this.model,
        onProgress: (s) => {
          if (this.resultKey() === key) this.status.setText(s);
        },
      });
      this.plugin.results.set(key, result);
      new Notice(`${action.name} finished in ${Math.round((Date.now() - started) / 1000)} s`);
      this.opts.onResult?.(result.text, action);
    } catch (e) {
      console.error("[ai-actions]", e);
      this.failures.set(key, e);
      new Notice(`${action.name} failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
    } finally {
      this.running = null;
      this.status.setText("");
      this.refresh();
    }
  }

  private async copy(): Promise<void> {
    const key = this.resultKey();
    const result = key ? this.plugin.results.get(key) : undefined;
    if (!result) return;
    await copyText(result.text);
    new Notice(`Copied ${result.text.length} characters`);
  }
}
