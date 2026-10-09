import { Editor, Modal, Notice } from "obsidian";
import type AiActionsPlugin from "../main";
import { RunOptions, RunResult, runAction } from "../ai/runAction";
import { Action } from "../types";
import { copyText, renderError, renderResult } from "./render";

export interface ResultModalOptions extends RunOptions {
  editor?: Editor;
  hasSelection?: boolean;
}

export class ResultModal extends Modal {
  private status: HTMLElement;
  private output: HTMLElement;
  private buttons: HTMLElement;

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
    this.contentEl.empty();
  }

  private async run(): Promise<void> {
    this.buttons.empty();
    this.output.empty();
    let result: RunResult | null = null;
    try {
      result = await runAction(this.plugin, this.action, this.text, {
        ...this.opts,
        onProgress: (s) => this.status.setText(s),
      });
      this.status.setText("");
      await renderResult(this.app, this.plugin, this.output, result);
    } catch (e) {
      this.status.setText("");
      renderError(this.output, e);
    }
    this.renderButtons(result);
  }

  private renderButtons(result: RunResult | null): void {
    const add = (text: string, onClick: () => void, cta = false) => {
      const b = this.buttons.createEl("button", { text });
      if (cta) b.addClass("mod-cta");
      b.onclick = onClick;
    };
    const { editor, hasSelection } = this.opts;
    if (result) {
      const text = result.text;
      add("Copy", () => void copyText(text).then(() => new Notice("Copied")), true);
      if (editor && hasSelection) {
        add("Replace selection", () => {
          editor.replaceSelection(text);
          this.close();
        });
      }
      if (editor) {
        add(hasSelection ? "Insert below selection" : "Insert at end", () => {
          const last = editor.lastLine();
          const pos = hasSelection ? editor.getCursor("to") : { line: last, ch: editor.getLine(last).length };
          editor.replaceRange(`\n\n${text}\n`, pos);
          this.close();
        });
      }
    }
    add("Run again", () => void this.run());
  }
}
