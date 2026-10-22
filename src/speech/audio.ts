export interface AudioPart {
  mime: string;
  bytes: Uint8Array;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = window.atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const ascii = (bytes: Uint8Array, at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

export function wavHeader(dataLength: number, rate: number, channels = 1, bits = 16): Uint8Array {
  const h = new DataView(new ArrayBuffer(44));
  const tag = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) h.setUint8(at + i, s.charCodeAt(i));
  };
  const block = (channels * bits) / 8;
  tag(0, "RIFF");
  h.setUint32(4, 36 + dataLength, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, channels, true);
  h.setUint32(24, rate, true);
  h.setUint32(28, rate * block, true);
  h.setUint16(32, block, true);
  h.setUint16(34, bits, true);
  tag(36, "data");
  h.setUint32(40, dataLength, true);
  return new Uint8Array(h.buffer);
}

/** Raw PCM for a WAV part (format and samples), or null when it is not a WAV the parser understands */
export function readWav(bytes: Uint8Array): { rate: number; channels: number; bits: number; data: Uint8Array } | null {
  if (bytes.length < 12 || ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let rate = 0, channels = 0, bits = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = ascii(bytes, at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
    } else if (id === "data") {
      return rate ? { rate, channels, bits, data: bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size)) } : null;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

const pcmRate = (mime: string): number | null =>
  /L16|pcm/i.test(mime) ? Number((/rate=(\d+)/.exec(mime) ?? [])[1]) || 24000 : null;

/** One playable part: raw 16-bit PCM (what Gemini returns) gets a WAV header, anything else is kept */
export function playable(part: AudioPart): AudioPart {
  const rate = pcmRate(part.mime);
  if (rate === null) return part;
  return { mime: "audio/wav", bytes: concat([wavHeader(part.bytes.length, rate), part.bytes]) };
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * All parts as one file. WAV parts with the same format are merged sample by sample;
 * MP3 frames simply follow each other. Mixed formats keep the first part's type.
 */
export function joinAudio(parts: AudioPart[]): { mime: string; ext: string; bytes: Uint8Array } {
  const ready = parts.map(playable);
  const wavs = ready.map((p) => readWav(p.bytes));
  if (wavs.length && wavs.every((w) => w && w.rate === wavs[0]?.rate && w.channels === wavs[0]?.channels && w.bits === wavs[0]?.bits)) {
    const first = wavs[0]!;
    const data = concat(wavs.map((w) => w!.data));
    return { mime: "audio/wav", ext: "wav", bytes: concat([wavHeader(data.length, first.rate, first.channels, first.bits), data]) };
  }
  const mime = ready[0]?.mime ?? "audio/mpeg";
  const ext = /mpeg|mp3/.test(mime) ? "mp3" : /ogg|opus/.test(mime) ? "ogg" : /aac|mp4/.test(mime) ? "m4a" : /flac/.test(mime) ? "flac" : "wav";
  return { mime, ext, bytes: concat(ready.map((p) => p.bytes)) };
}
