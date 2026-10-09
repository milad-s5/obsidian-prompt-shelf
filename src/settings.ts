import { App, Notice, PluginSettingTab, Setting, TextComponent } from "obsidian";
import type PromptShelfPlugin from "./main";
import { AiError } from "./ai/errors";
import { ModelPicker } from "./ui/pickers";
import { FolderSuggest } from "./ui/FolderSuggest";
import { Action, DEFAULT_ACTIONS, PRESETS, PROVIDER_TYPES, Provider, ProviderType, THINKING_LEVELS, ThinkingLevel } from "./types";

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const errorText = (e: unknown) => (e instanceof AiError || e instanceof Error ? e.message : String(e));

export class PromptShelfSettingTab extends PluginSettingTab {
  private openActions = new Set<string>();

  constructor(app: App, private plugin: PromptShelfPlugin) {
    super(app, plugin);
  }

  private get s() {
    return this.plugin.settings;
  }

  private save(): Promise<void> {
    return this.plugin.saveSettings();
  }

  private redraw(): void {
    const top = this.containerEl.scrollTop;
    this.display();
    this.containerEl.scrollTop = top;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("psh-settings");

    this.renderGeneral(containerEl);

    new Setting(containerEl).setName("Providers").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "API keys are stored in the plugin's secret.json, not in data.json, and are never shown again after saving. Add that file to your sync or Git ignore list.",
    });
    for (const p of this.s.providers) this.renderProvider(containerEl, p);
    this.renderAddProvider(containerEl);

    new Setting(containerEl).setName("Actions").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "{{text}} is replaced by the input text; without it, the text is appended to the prompt. {{language}} is the output language above. Scripts can pass more variables such as {{title}}; a line whose variables are all empty is left out. The merge prompt is used only when a long text was split into parts: it combines their results. Leave it empty to join the parts as they are.",
    });
    this.s.actions.forEach((a, i) => this.renderAction(containerEl, a, i));
    this.renderActionButtons(containerEl);

    this.renderSaving(containerEl);

    new Setting(containerEl).setName("Long texts and network").setHeading();
    new Setting(containerEl)
      .setName("Stream answers")
      .setDesc("Show the answer while it is being written. Providers that do not allow it fall back to waiting for the whole answer.")
      .addToggle((t) =>
        t.setValue(this.s.streaming).onChange(async (v) => {
          this.s.streaming = v;
          await this.save();
        })
      );
    this.numberSetting(containerEl, "Chunk size", "Texts longer than this many characters are sent in parts. 0 sends everything at once, for models with a large context window.", "chunkChars");
    this.numberSetting(containerEl, "Max output tokens", "Sent to Anthropic, which requires it. Other providers use their own limit.", "maxTokens");
    this.numberSetting(containerEl, "Timeout", "Seconds to wait for each request.", "timeoutSec");
  }

  private renderGeneral(el: HTMLElement): void {
    const options = this.plugin.client.modelOptions();

    new Setting(el)
      .setName("Default model")
      .setDesc("Used by actions that do not name their own model.")
      .addDropdown((d) => {
        d.addOption("", "First provider with a key");
        for (const o of options) d.addOption(o.ref, o.label);
        d.setValue(this.s.defaultModel).onChange(async (v) => {
          this.s.defaultModel = v;
          await this.save();
        });
      });

    const fallback = new Setting(el)
      .setName("Fallback models")
      .setDesc("Tried in order when the chosen model fails, for example when a free model is rate limited.");
    const list = fallback.descEl.createEl("ol", { cls: "psh-fallbacks" });
    this.s.fallbackModels.forEach((ref, i) => {
      const li = list.createEl("li");
      li.createSpan({ text: options.find((o) => o.ref === ref)?.label ?? `${ref} (missing)` });
      const remove = li.createEl("button", { cls: "psh-link", text: "Remove" });
      remove.onclick = async () => {
        this.s.fallbackModels.splice(i, 1);
        await this.save();
        this.redraw();
      };
    });
    let pick = "";
    fallback
      .addDropdown((d) => {
        d.addOption("", "Add a fallback…");
        for (const o of options) if (!this.s.fallbackModels.includes(o.ref)) d.addOption(o.ref, o.label);
        d.onChange((v) => (pick = v));
      })
      .addButton((b) =>
        b.setButtonText("Add").onClick(async () => {
          if (!pick) return;
          this.s.fallbackModels.push(pick);
          await this.save();
          this.redraw();
        })
      );

    new Setting(el)
      .setName("Output language")
      .setDesc("Fills {{language}} in the prompts, for example English or Persian.")
      .addText((t) =>
        t.setValue(this.s.language).onChange(async (v) => {
          this.s.language = v.trim();
          await this.save();
        })
      );
  }

  private renderProvider(el: HTMLElement, p: Provider): void {
    const box = el.createDiv({ cls: "psh-box" });

    new Setting(box)
      .setName("Name")
      .addText((t) => {
        t.setValue(p.name).onChange(async (v) => {
          p.name = v;
          await this.save();
        });
        t.inputEl.addEventListener("change", () => this.redraw());
      })
      .addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Remove provider").onClick(async () => {
          this.s.providers = this.s.providers.filter((x) => x !== p);
          this.s.fallbackModels = this.s.fallbackModels.filter((r) => !r.startsWith(`${p.id}|`));
          if (this.s.defaultModel.startsWith(`${p.id}|`)) this.s.defaultModel = "";
          await this.plugin.keys.clear(p.id);
          await this.save();
          this.redraw();
        })
      );

    new Setting(box).setName("Type").addDropdown((d) => {
      for (const [k, label] of Object.entries(PROVIDER_TYPES)) d.addOption(k, label);
      d.setValue(p.type).onChange(async (v) => {
        p.type = v as ProviderType;
        await this.save();
      });
    });

    new Setting(box).setName("Base URL").addText((t) => {
      t.inputEl.addClass("psh-wide");
      t.setPlaceholder("Address ending in /v1")
        .setValue(p.baseUrl)
        .onChange(async (v) => {
          p.baseUrl = v.trim();
          await this.save();
        });
    });

    this.renderKey(box, p);

    new Setting(box)
      .setName("Models")
      .setDesc("Comma-separated. The first one is this provider's default.")
      .addText((t) => {
        t.inputEl.addClass("psh-wide");
        t.setValue(p.models.join(", ")).onChange(async (v) => {
          p.models = v.split(",").map((m) => m.trim()).filter(Boolean);
          await this.save();
        });
        // Every model dropdown on this page lists these, so redraw once editing is done
        t.inputEl.addEventListener("change", () => this.redraw());
      });

    new Setting(box)
      .addButton((b) =>
        b.setButtonText("Browse models").onClick(async () => {
          b.setDisabled(true);
          try {
            const models = await this.plugin.client.listModels(p);
            if (!models.length) {
              new Notice(`${p.name} returned no models.`);
              return;
            }
            new ModelPicker(this.app, models, (m) => {
              if (!p.models.includes(m.id)) p.models.push(m.id);
              void this.save().then(() => {
                new Notice(`Added ${m.id}`);
                this.redraw();
              });
            }).open();
          } catch (e) {
            new Notice(errorText(e), 10000);
          } finally {
            b.setDisabled(false);
          }
        })
      )
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          const model = p.models[0];
          if (!model) {
            new Notice("Add a model first.");
            return;
          }
          b.setDisabled(true).setButtonText("Testing…");
          try {
            const r = await this.plugin.client.chatWith(
              { provider: p, model },
              { prompt: "Reply with the single word OK.", maxTokens: p.type === "anthropic" ? 32 : undefined }
            );
            new Notice(`${r.model} works: "${r.text.trim().slice(0, 60)}"`, 6000);
          } catch (e) {
            new Notice(errorText(e), 10000);
          } finally {
            b.setDisabled(false).setButtonText("Test");
          }
        })
      );
  }

  private renderKey(box: HTMLElement, p: Provider): void {
    const has = this.plugin.keys.has(p.id);
    const setting = new Setting(box)
      .setName("API key")
      .setDesc(has ? "A key is saved. Saving again replaces it." : "No key saved yet. Local servers such as Ollama do not need one.");
    setting.descEl.toggleClass("mod-success", has);

    let field: TextComponent | null = null;
    const saveKey = async () => {
      const value = field?.getValue().trim() ?? "";
      if (!value) {
        new Notice("Paste a key first.");
        return;
      }
      await this.plugin.keys.set(p.id, value);
      new Notice(`Key saved for ${p.name}`);
      this.plugin.refreshPanels();
      this.redraw();
    };

    setting.addText((t) => {
      field = t;
      t.inputEl.type = "password";
      t.inputEl.autocomplete = "off";
      t.inputEl.spellcheck = false;
      t.setPlaceholder(has ? "••••••••" : "Paste key");
      t.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        void saveKey();
      });
    });
    setting.addButton((b) => b.setButtonText("Save").setCta().onClick(() => void saveKey()));
    if (has) {
      setting.addButton((b) => {
        b.buttonEl.addClass("mod-warning");
        b.setButtonText("Clear").onClick(async () => {
          await this.plugin.keys.clear(p.id);
          new Notice(`Key cleared for ${p.name}`);
          this.plugin.refreshPanels();
          this.redraw();
        });
      });
    }
  }

  private renderAddProvider(el: HTMLElement): void {
    let preset = 0;
    new Setting(el)
      .setName("Add a provider")
      .setDesc("Any OpenAI-compatible service works through the custom option.")
      .addDropdown((d) => {
        for (const [i, x] of PRESETS.entries()) d.addOption(String(i), x.name);
        d.onChange((v) => (preset = Number(v)));
      })
      .addButton((b) =>
        b.setButtonText("Add").setCta().onClick(async () => {
          const x = PRESETS[preset];
          this.s.providers.push({ id: uid("p"), name: x.name, type: x.type, baseUrl: x.baseUrl, models: [...x.models] });
          await this.save();
          this.redraw();
        })
      );
  }

  private renderAction(el: HTMLElement, a: Action, index: number): void {
    const box = el.createEl("details", { cls: "psh-box" });
    box.open = this.openActions.has(a.id);
    box.ontoggle = () => (box.open ? this.openActions.add(a.id) : this.openActions.delete(a.id));
    const summary = box.createEl("summary");
    const title = summary.createSpan({ text: a.name });
    summary.createSpan({ cls: "psh-muted psh-id", text: a.id });

    new Setting(box)
      .setName("Name")
      .addText((t) =>
        t.setValue(a.name).onChange(async (v) => {
          a.name = v;
          title.setText(v);
          await this.save();
        })
      )
      .addExtraButton((b) =>
        b.setIcon("arrow-up").setTooltip("Move up").setDisabled(index === 0).onClick(async () => {
          if (index === 0) return;
          this.s.actions.splice(index - 1, 0, ...this.s.actions.splice(index, 1));
          await this.save();
          this.redraw();
        })
      )
      .addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Remove action").onClick(async () => {
          this.s.actions = this.s.actions.filter((x) => x !== a);
          await this.save();
          this.redraw();
        })
      );

    new Setting(box)
      .setName("ID")
      .setDesc('The ID scripts use to call this action, as in run("summarize", text).')
      .addText((t) =>
        t.setValue(a.id).onChange(async (v) => {
          const id = v.trim();
          if (!id || this.s.actions.some((x) => x !== a && x.id === id)) return;
          this.openActions.delete(a.id);
          a.id = id;
          this.openActions.add(id);
          await this.save();
        })
      );

    new Setting(box).setName("Model").addDropdown((d) => {
      d.addOption("", "Default model");
      for (const o of this.plugin.client.modelOptions()) d.addOption(o.ref, o.label);
      d.setValue(a.model).onChange(async (v) => {
        a.model = v;
        await this.save();
      });
    });

    new Setting(box)
      .setName("Thinking")
      .setDesc("How much the model reasons before answering. Lower is faster; summaries rarely need more than low. Not every model accepts every level.")
      .addDropdown((d) => {
        for (const [k, label] of Object.entries(THINKING_LEVELS)) d.addOption(k, label);
        d.setValue(a.thinking ?? "").onChange(async (v) => {
          a.thinking = v as ThinkingLevel;
          await this.save();
        });
      });

    const area = (name: string, key: "system" | "prompt" | "mergePrompt", rows: number) => {
      const s = new Setting(box).setName(name).addTextArea((t) => {
        t.inputEl.rows = rows;
        t.inputEl.dir = "auto";
        t.inputEl.addClass("psh-wide");
        t.setValue(a[key]).onChange(async (v) => {
          a[key] = v;
          await this.save();
        });
      });
      s.settingEl.addClass("psh-stacked");
    };
    area("System prompt", "system", 3);
    area("Prompt", "prompt", 8);
    area("Merge prompt", "mergePrompt", 3);
  }

  private renderActionButtons(el: HTMLElement): void {
    new Setting(el)
      .addButton((b) =>
        b.setButtonText("New action").setCta().onClick(async () => {
          const a: Action = { id: uid("action"), name: "New action", model: "", thinking: "", system: "", prompt: "{{text}}", mergePrompt: "" };
          this.s.actions.push(a);
          this.openActions.add(a.id);
          await this.save();
          this.redraw();
        })
      )
      .addButton((b) =>
        b.setButtonText("Restore built-in actions").onClick(async () => {
          const missing = DEFAULT_ACTIONS.filter((d) => !this.s.actions.some((a) => a.id === d.id));
          this.s.actions.push(...missing.map((m) => ({ ...m })));
          new Notice(missing.length ? `Restored ${missing.length} action(s)` : "All built-in actions are already there.");
          await this.save();
          this.redraw();
        })
      );
  }

  private renderSaving(el: HTMLElement): void {
    new Setting(el).setName("Saving answers").setHeading();
    new Setting(el)
      .setName("Folder")
      .setDesc("Where saved answers go. Created if missing; empty means the vault root.")
      .addText((t) => {
        const store = async (v: string) => {
          this.s.saveFolder = v.trim().replace(/^\/+|\/+$/g, "");
          await this.save();
        };
        t.setPlaceholder("Inbox").setValue(this.s.saveFolder).onChange(store);
        new FolderSuggest(this.app, t.inputEl, (path) => void store(path));
      });
    new Setting(el)
      .setName("Note name")
      .setDesc("Uses the same variables as prompts, plus {{action}}, {{date}} and {{time}}. Falls back to the action and date when the name comes out empty.")
      .addText((t) =>
        t.setValue(this.s.saveName).onChange(async (v) => {
          this.s.saveName = v;
          await this.save();
        })
      );
    new Setting(el)
      .setName("Add properties")
      .setDesc("Write the action, model, date and the script's variables (such as title or URL) as note properties.")
      .addToggle((t) =>
        t.setValue(this.s.saveFrontmatter).onChange(async (v) => {
          this.s.saveFrontmatter = v;
          await this.save();
        })
      );
    new Setting(el)
      .setName("Open after saving")
      .addToggle((t) =>
        t.setValue(this.s.openAfterSave).onChange(async (v) => {
          this.s.openAfterSave = v;
          await this.save();
        })
      );
  }

  private numberSetting(el: HTMLElement, name: string, desc: string, key: "chunkChars" | "maxTokens" | "timeoutSec"): void {
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(this.s[key])).onChange(async (v) => {
          this.s[key] = Math.max(0, Math.floor(Number(v) || 0));
          await this.save();
        });
      });
  }
}
