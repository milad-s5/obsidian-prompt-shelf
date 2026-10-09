import { Editor, Modal, Notice } from "obsidian";
import type AiActionsPlugin from "../main";
import { RunOptions, RunResult, runAction } from "../ai/runAction";
import { saveAsNote } from "../notes/saveNote";
import { Action } from "../types";
import { StreamView, copyText, releaseOutput, renderError, renderResult } from "./render";

export interface ResultModalOptions extends RunOptions {
  editor?: Editor;
  hasSelection?: boolean;
}

export class ResultModal extends Modal {
  private status: HTMLElement;
  private output: HTMLElement;
  private buttons: HTMLElement;
  private controller: AbortController | null = null;

  constructor(private plugin: AiActionsPlugin, private action: Action, private text: string, private opts: ResultModalOptions = {}) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("aia-modal");
    this.titleEl.setText(this.action.name);
    this.status = this.contentEl.createDiv({ cls: "aia-muted" });
    this.output = this.contentEl.createDiv({ cls: "aia-output" });
    this.buttons = this.contentEl.createDiv({ cls: "aia-row aia-buttons" });
    void this.run();
  }

  onClose(): void {
    this.controller?.abort();
    releaseOutput(this.output);
    this.contentEl.empty();
  }

  private async run(): Promise<void> {
    this.output.empty();
    this.buttons.empty();
    const controller = new AbortController();
    this.controller = controller;
    this.buttons.createEl("button", { text: "Stop", cls: "mod-warning" }).onclick = () => controller.abort();

    const view = new StreamView(this.app, this.output);
    let result: RunResult | null = null;
    try {
      result = await runAction(this.plugin, this.action, this.text, {
        ...this.opts,
        signal: controller.signal,
        onProgress: (s) => this.status.setText(s),
        onPartial: (t) => view.update(t),
      });
      view.stop();
      this.status.setText("");
      await renderResult(this.app, this.output, result);
    } catch (e) {
      view.stop();
      this.status.setText("");
      renderError(this.output, e);
    } finally {
      this.controller = null;
    }
    this.renderButtons(result);
  }

  private renderButtons(result: RunResult | null): void {
    this.buttons.empty();
    const add = (text: string, onClick: () => unknown, cta = false) => {
      const b = this.buttons.createEl("button", { text });
      if (cta) b.addClass("mod-cta");
      b.onclick = onClick;
    };
    const { editor, hasSelection } = this.opts;
    if (result) {
      const r = result;
      add("Copy", () => void copyText(r.text).then(() => new Notice("Copied")), true);
      add("Save as note", async () => {
        const file = await saveAsNote(this.plugin, r.text, { action: this.action.name, models: r.models, vars: this.opts.vars });
        new Notice(`Saved to ${file.path}`);
        this.close();
      });
      if (editor && hasSelection) {
        add("Replace selection", () => {
          editor.replaceSelection(r.text);
          this.close();
        });
      }
      if (editor) {
        add(hasSelection ? "Insert below selection" : "Insert at end", () => {
          const last = editor.lastLine();
          const pos = hasSelection ? editor.getCursor("to") : { line: last, ch: editor.getLine(last).length };
          editor.replaceRange(`\n\n${r.text}\n`, pos);
          this.close();
        });
      }
    }
    add("Run again", () => void this.run());
  }
}
