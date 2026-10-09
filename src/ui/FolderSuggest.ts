import { AbstractInputSuggest, App, TFolder } from "obsidian";

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(private vaultApp: App, private input: HTMLInputElement, private onPick: (path: string) => void) {
    super(vaultApp, input);
  }

  protected getSuggestions(query: string): TFolder[] {
    const q = query.trim().toLowerCase();
    return this.vaultApp.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && !f.isRoot() && f.path.toLowerCase().includes(q))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.input.value = folder.path;
    this.onPick(folder.path);
    this.close();
  }
}
