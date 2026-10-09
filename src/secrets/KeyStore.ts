import { App } from "obsidian";

/**
 * API keys live in their own file next to the plugin, never in data.json, which many
 * vaults commit to git. Keyed by provider id.
 */
const SECRET_FILE = "secret.json";

export class KeyStore {
  private keys: Record<string, string> = {};

  constructor(private app: App, private pluginDir: string) {}

  private get path(): string {
    return `${this.pluginDir}/${SECRET_FILE}`;
  }

  async load(): Promise<void> {
    try {
      if (!(await this.app.vault.adapter.exists(this.path))) return;
      const parsed = JSON.parse(await this.app.vault.adapter.read(this.path)) as { keys?: unknown };
      if (parsed.keys && typeof parsed.keys === "object") this.keys = parsed.keys as Record<string, string>;
    } catch {
      this.keys = {};
    }
  }

  get(providerId: string): string {
    return this.keys[providerId] ?? "";
  }

  has(providerId: string): boolean {
    return Boolean(this.keys[providerId]);
  }

  async set(providerId: string, key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("Empty key");
    this.keys[providerId] = trimmed;
    await this.persist();
  }

  async clear(providerId: string): Promise<void> {
    delete this.keys[providerId];
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.app.vault.adapter.write(this.path, JSON.stringify({ keys: this.keys }, null, 2));
  }
}
