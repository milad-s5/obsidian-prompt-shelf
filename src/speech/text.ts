/** Markdown reduced to what a voice should say: no code, link targets, timestamps or list marks */
export function speechText(md: string): string {
  return String(md || "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\d{1,2}(?::\d{2}){1,2}\]/g, "")
    .replace(/^\s*>\s*\[![^\]]*\][+-]?\s*/gm, "")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_`~|=]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Sentences grouped into parts that grow from `first` to `size` characters, so the
 * first part is ready quickly and each next part is made while the previous one plays
 */
export function speechChunks(text: string, first = 500, size = 2000): string[] {
  const sentences: string[] = [];
  for (const raw of splitSentences(text)) {
    let s = raw;
    while (s.length > size) {
      const cut = s.lastIndexOf(" ", size);
      sentences.push(s.slice(0, cut > 0 ? cut : size));
      s = s.slice(cut > 0 ? cut + 1 : size);
    }
    if (s.trim()) sentences.push(s.trim());
  }
  const chunks: string[] = [];
  for (const s of sentences) {
    const last = chunks.length - 1;
    const limit = last === 0 ? first : last === 1 ? first * 2 : size;
    if (last >= 0 && chunks[last].length + s.length + 1 <= limit) chunks[last] += ` ${s}`;
    else chunks.push(s);
  }
  return chunks;
}

/** Splits after sentence ends without lookbehind, which some iOS versions lack */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?؟…]+["'”’)]?\s+|\n+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const piece = text.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}
