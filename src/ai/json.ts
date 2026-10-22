export type JsonObject = Record<string, unknown>;

export const obj = (v: unknown): JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : {};

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

export const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";

/** The first fenced block's content when there is one, so prose around it falls away too */
export function stripFences(text: string): string {
  const fenced = /```[\w-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/** undefined when the text is not JSON */
export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
