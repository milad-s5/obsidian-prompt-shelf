import { Notice } from "obsidian";
import type AiActionsPlugin from "../main";
import { RunResult, Vars, runAction } from "../ai/runAction";
import { saveAsNote } from "../notes/saveNote";
import { Action } from "../types";
import { StreamView, copyText, releaseOutput, renderError, renderResult } from "./render";

export interface PanelButton {
  text: string;
  onClick: (text: string, action: Action) => unknown;
}

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
  /** Extra buttons shown next to Copy, enabled once there is an answer */
  buttons?: PanelButton[];
  onResult?: (text: string, action: Action) => void;
}

export class ActionPanel {
  readonly el: HTMLElement;
  private actionSelect: HTMLSelectElement;
  private modelSelect: HTMLSelectElement;
  private runButton: HTMLButtonElement;
  private resultButtons: HTMLButtonElement[] = [];
  private status: HTMLElement;
  private output: HTMLElement;
  private id: string;
  private actionId: string;
  private model: string;
  private running: { key: string; controller: AbortController } | null = null;
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
    this.runButton = row.createEl("button", { cls: "mod-cta" });
    this.runButton.onclick = () => (this.running ? this.running.controller.abort() : void this.run());
    row.createEl("button", { text: "Settings" }).onclick = () => plugin.openSettings();

    const actions = el.createDiv({ cls: "aia-row aia-result-actions" });
    const addResultButton = (text: string, onClick: (text: string, action: Action) => unknown) => {
      const b = actions.createEl("button", { text });
      b.onclick = async () => {
        const result = this.result();
        const action = this.action;
        if (!result || !action) return;
        try {
          await onClick(result, action);
        } catch (e) {
          console.error("[ai-actions]", e);
          new Notice(e instanceof Error ? e.message : String(e), 8000);
        }
      };
      this.resultButtons.push(b);
    };
    addResultButton("Copy", async (text) => {
      await copyText(text);
      new Notice(`Copied ${text.length} characters`);
    });
    addResultButton("Save as note", async (text, action) => {
      const key = this.resultKey();
      const file = await saveAsNote(plugin, text, {
        action: action.name,
        models: key ? plugin.results.get(key)?.models : undefined,
        vars: this.opts.vars,
      });
      new Notice(`Saved to ${file.path}`);
    });
    for (const b of opts.buttons ?? []) addResultButton(b.text, b.onClick);

    this.status = el.createDiv({ cls: "aia-muted aia-status" });
    this.output = el.createDiv({ cls: "aia-output" });

    plugin.panels.add(this);
    this.refresh();
  }

  dispose(): void {
    this.running?.controller.abort();
    releaseOutput(this.output);
  }

  /** The answer currently shown, if any */
  result(): string | null {
    const key = this.resultKey();
    return (key && this.plugin.results.get(key)?.text) || null;
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
    const busy = key !== null && this.running?.key === key;
    const ready = this.plugin.client.candidates(this.model || action?.model).length > 0;
    const hasText = key !== null && Boolean(this.opts.getText().trim());
    const result = key ? this.plugin.results.get(key) : undefined;
    const failure = key ? this.failures.get(key) : undefined;

    this.actionSelect.disabled = this.modelSelect.disabled = this.running !== null;
    this.runButton.setText(busy ? "Stop" : result ? "Run again" : "Run");
    this.runButton.toggleClass("mod-warning", busy);
    this.runButton.toggleClass("mod-cta", !busy);
    this.runButton.disabled = !busy && (this.running !== null || !ready || !hasText || !action);
    for (const b of this.resultButtons) b.disabled = !result || busy;
    if (!busy) {
      this.status.setText(!ready ? "No model is set up yet — open Settings to add a provider and key."
        : !hasText ? "No text to send yet." : this.running ? "Another run is in progress…" : "");
    }

    if (busy) return;
    const shown = result ? `ok:${key}` : failure ? `err:${key}` : "";
    if (shown === this.shown) return;
    this.shown = shown;
    this.output.empty();
    if (result) void renderResult(this.plugin.app, this.output, result);
    else if (failure) renderError(this.output, failure);
    this.output.toggleClass("aia-hidden", !result && !failure);
  }

  async run(): Promise<void> {
    const action = this.action;
    const key = this.resultKey();
    if (!action || key === null || this.running) return;
    const controller = new AbortController();
    this.running = { key, controller };
    this.failures.delete(key);
    this.shown = null;
    this.output.empty();
    this.output.removeClass("aia-hidden");
    this.refresh();

    const view = new StreamView(this.plugin.app, this.output);
    const visible = () => this.resultKey() === key;
    const started = Date.now();
    try {
      const result: RunResult = await runAction(this.plugin, action, this.opts.getText(), {
        vars: this.opts.vars,
        model: this.model,
        signal: controller.signal,
        onProgress: (s) => {
          if (visible()) this.status.setText(s);
        },
        onPartial: (t) => {
          if (visible()) view.update(t);
        },
      });
      this.plugin.results.set(key, result);
      new Notice(`${action.name} finished in ${Math.round((Date.now() - started) / 1000)} s`);
      this.opts.onResult?.(result.text, action);
    } catch (e) {
      if (!controller.signal.aborted) {
        console.error("[ai-actions]", e);
        new Notice(`${action.name} failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
      }
      this.failures.set(key, e);
    } finally {
      view.stop();
      this.running = null;
      this.status.setText("");
      this.shown = null;
      this.refresh();
    }
  }
}
