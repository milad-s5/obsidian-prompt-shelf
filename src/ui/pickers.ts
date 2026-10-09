import { App, FuzzySuggestModal } from "obsidian";
import { ModelInfo } from "../ai/adapters";
import { Action } from "../types";

export class ActionPicker extends FuzzySuggestModal<Action> {
  constructor(app: App, private actions: Action[], private onPick: (a: Action) => void) {
    super(app);
    this.setPlaceholder("Choose an action");
  }

  getItems(): Action[] {
    return this.actions;
  }

  getItemText(a: Action): string {
    return a.name;
  }

  onChooseItem(a: Action): void {
    this.onPick(a);
  }
}

export class ModelPicker extends FuzzySuggestModal<ModelInfo> {
  constructor(app: App, private models: ModelInfo[], private onPick: (m: ModelInfo) => void) {
    super(app);
    const free = models.filter((m) => m.free).length;
    this.setPlaceholder(`${models.length} models${free ? `, ${free} free — type "free" to list them` : ""}`);
  }

  getItems(): ModelInfo[] {
    return this.models;
  }

  getItemText(m: ModelInfo): string {
    return m.free ? `${m.id} (free)` : m.id;
  }

  onChooseItem(m: ModelInfo): void {
    this.onPick(m);
  }
}
