import { Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin } from "obsidian";
import { AiActionsSettings, DEFAULT_ACTIONS, DEFAULT_SETTINGS } from "./types";
import { AiActionsSettingTab } from "./settings";
import { KeyStore } from "./secrets/KeyStore";
import { AiClient, ChatRequest, ChatResult, ModelOption } from "./ai/AiClient";
import { RunOptions, RunResult, runAction } from "./ai/runAction";
import { AiError } from "./ai/errors";
import { ActionPanel, PanelOptions } from "./ui/ActionPanel";
import { ActionPicker } from "./ui/pickers";
import { ResultModal } from "./ui/ResultModal";

export interface AiActionsApi {
  version: number;
  run(actionId: string, text: string, opts?: RunOptions): Promise<string>;
  runDetailed(actionId: string, text: string, opts?: RunOptions): Promise<RunResult>;
  chat(req: ChatRequest): Promise<ChatResult>;
  actions(): { id: string; name: string }[];
  models(): ModelOption[];
  ready(): boolean;
  panel(el: HTMLElement, opts: PanelOptions): ActionPanel;
  pick(text: string, opts?: RunOptions): void;
  openSettings(): void;
}

export default class AiActionsPlugin extends Plugin {
  settings: AiActionsSettings;
  keys: KeyStore;
  client: AiClient;
  api: AiActionsApi;
  results = new Map<string, RunResult>();
  panels = new Set<ActionPanel>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.keys = new KeyStore(this.app, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    await this.keys.load();
    this.client = new AiClient(this);

    this.api = {
      version: 1,
      run: async (id, text, opts) => (await this.runById(id, text, opts)).text,
      runDetailed: (id, text, opts) => this.runById(id, text, opts),
      chat: (req) => this.client.chat(req),
      actions: () => this.settings.actions.map((a) => ({ id: a.id, name: a.name })),
      models: () => this.client.modelOptions(),
      ready: () => this.client.candidates().length > 0,
      panel: (el, opts) => new ActionPanel(this, el, opts),
      pick: (text, opts) => this.pick(text, opts),
      openSettings: () => this.openSettings(),
    };

    this.addSettingTab(new AiActionsSettingTab(this.app, this));

    this.addCommand({
      id: "run-action",
      name: "Run an action on the selection or the whole note",
      editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
        const selection = editor.getSelection();
        const text = selection || editor.getValue();
        if (!text.trim()) {
          new Notice("There is no text to send.");
          return;
        }
        this.pick(text, { vars: { title: ctx.file?.basename ?? "" } }, editor, Boolean(selection));
      },
    });
  }

  onunload(): void {
    this.panels.clear();
  }

  async loadSettings(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<AiActionsSettings>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    if (!Array.isArray(stored.actions)) this.settings.actions = JSON.parse(JSON.stringify(DEFAULT_ACTIONS));
    this.settings.panels = { ...(stored.panels ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshPanels();
  }

  refreshPanels(): void {
    for (const panel of this.panels) {
      if (panel.el.isConnected) panel.refresh();
      else this.panels.delete(panel);
    }
  }

  openSettings(): void {
    const setting = (this.app as any).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  private runById(id: string, text: string, opts?: RunOptions): Promise<RunResult> {
    const action = this.settings.actions.find((a) => a.id === id);
    if (!action) return Promise.reject(new AiError("input", `There is no action with the id "${id}".`));
    return runAction(this, action, text, opts);
  }

  private pick(text: string, opts: RunOptions = {}, editor?: Editor, hasSelection = false): void {
    new ActionPicker(this.app, this.settings.actions, (action) =>
      new ResultModal(this, action, text, { ...opts, editor, hasSelection }).open()
    ).open();
  }
}
