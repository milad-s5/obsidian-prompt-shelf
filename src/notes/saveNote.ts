import { moment, normalizePath, TFile } from "obsidian";
import type PromptShelfPlugin from "../main";
import { fillTemplate, Vars } from "../ai/runAction";

export interface SaveOptions {
  action?: string;
  models?: string[];
  vars?: Vars | (() => Vars);
  folder?: string;
  name?: string;
  open?: boolean;
}

const SKIPPED_VARS = new Set(["text", "language"]);

const sanitizeName = (s: string): string =>
  s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120).trim();

function yamlValue(v: unknown): string | null {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v.trim() ? JSON.stringify(v.trim()) : null;
  return null;
}

function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .filter(([k]) => /^[A-Za-z_][\w-]*$/.test(k) && !SKIPPED_VARS.has(k))
    .map(([k, v]) => [k, yamlValue(v)] as const)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${v}`);
  return lines.length ? `---\n${lines.join("\n")}\n---\n\n` : "";
}

async function ensureFolder(plugin: PromptShelfPlugin, folder: string): Promise<void> {
  if (!folder || folder === "/") return;
  let path = "";
  for (const part of folder.split("/")) {
    path = path ? `${path}/${part}` : part;
    if (!plugin.app.vault.getAbstractFileByPath(path)) {
      try {
        await plugin.app.vault.createFolder(path);
      } catch {
        // Created in the meantime
      }
    }
  }
}

export async function saveAsNote(plugin: PromptShelfPlugin, text: string, opts: SaveOptions = {}): Promise<TFile> {
  const s = plugin.settings;
  const vars = typeof opts.vars === "function" ? opts.vars() : opts.vars ?? {};
  const now = moment();
  const nameVars = { ...vars, action: opts.action ?? "", date: now.format("YYYY-MM-DD"), time: now.format("HH-mm") };

  const folder = normalizePath(opts.folder ?? s.saveFolder ?? "").replace(/^\/+|\/+$/g, "");
  const base = sanitizeName(opts.name ?? fillTemplate(s.saveName || "{{action}} {{date}}", nameVars, false))
    || sanitizeName(`${opts.action || "AI answer"} ${nameVars.date} ${nameVars.time}`);

  await ensureFolder(plugin, folder);
  const prefix = folder ? `${folder}/` : "";
  let path = normalizePath(`${prefix}${base}.md`);
  for (let i = 2; plugin.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${prefix}${base} ${i}.md`);

  const head = s.saveFrontmatter
    ? frontmatter({ ...vars, action: opts.action, model: opts.models?.join(", "), created: now.format("YYYY-MM-DDTHH:mm") })
    : "";
  const file = await plugin.app.vault.create(path, `${head}${text.trim()}\n`);
  if (opts.open ?? s.openAfterSave) await plugin.app.workspace.getLeaf("tab").openFile(file);
  return file;
}
