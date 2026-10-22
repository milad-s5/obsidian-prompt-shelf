import { moment, normalizePath, TFile } from "obsidian";
import type PromptShelfPlugin from "../main";
import { AiError } from "../ai/errors";
import { AudioPart, joinAudio, playable } from "./audio";
import { SynthResult, SynthStatus, Synthesizer } from "./synth";
import { speechChunks, speechText } from "./text";

export type SpeechPhase = "preparing" | "waiting" | "playing" | "paused" | "done" | "failed" | "stopped";

export interface SpeechState {
  id: string;
  title: string;
  phase: SpeechPhase;
  /** 1-based part being prepared or played */
  part: number;
  total: number;
  /** When the current part's audio started being made */
  since: number;
  /** When a quota wait ends */
  until: number;
  model: string;
  /** 0–1 over the whole text */
  progress: number;
  error: string;
  saving: { ready: number } | null;
  saved: string;
}

export interface SpeakOptions {
  id?: string;
  title?: string;
  /** Note the text came from; saved audio goes to its attachment folder */
  sourcePath?: string;
  /** Called with a link to the saved audio file, to put it in the note */
  insertLink?: (link: string) => void;
}

export interface SpeechHandle {
  done: Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
}

interface Job {
  promise: Promise<SynthResult>;
  start: number;
  status: SynthStatus;
}

const sanitize = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

export class SpeechSession implements SpeechHandle {
  state: SpeechState;
  done: Promise<void>;
  readonly text: string;
  private chunks: string[];
  private jobs = new Map<number, Job>();
  private controller = new AbortController();
  private audio: HTMLAudioElement | null = null;
  private stopPlayback: (() => void) | null = null;
  private waitingFor = -1;
  private failedAt = 0;
  private finish: () => void = () => undefined;

  constructor(private speech: SpeechController, private synth: Synthesizer, text: string, private opts: SpeakOptions) {
    this.text = text;
    this.chunks = speechChunks(speechText(text));
    this.state = {
      id: opts.id ?? "",
      title: opts.title ?? "",
      phase: "preparing",
      part: 1,
      total: this.chunks.length,
      since: Date.now(),
      until: 0,
      model: "",
      progress: 0,
      error: "",
      saving: null,
      saved: "",
    };
    this.done = new Promise((resolve) => (this.finish = resolve));
  }

  get empty(): boolean {
    return this.chunks.length === 0;
  }

  private set(patch: Partial<SpeechState>): void {
    this.state = { ...this.state, ...patch };
    this.speech.changed(this);
  }

  private job(i: number): Job {
    const existing = this.jobs.get(i);
    if (existing) return existing;
    const status: SynthStatus = { phase: "preparing", model: "", until: 0 };
    const promise = this.synth.synthesize(this.chunks[i], {
      signal: this.controller.signal,
      onStatus: (s) => {
        Object.assign(status, s);
        if (this.waitingFor === i) this.set({ phase: s.phase, model: s.model, until: s.until });
      },
    });
    promise.catch(() => this.jobs.delete(i));
    const job: Job = { promise, start: Date.now(), status };
    this.jobs.set(i, job);
    return job;
  }

  async run(from = 0): Promise<void> {
    let i = from;
    try {
      for (; i < this.chunks.length; i++) {
        const job = this.job(i);
        this.waitingFor = i;
        this.set({
          phase: job.status.phase, part: i + 1, since: job.start, until: job.status.until, model: job.status.model,
          error: "", progress: i / this.chunks.length,
        });
        const part = await job.promise;
        this.waitingFor = -1;
        if (this.controller.signal.aborted) return;
        if (i + 1 < this.chunks.length) this.job(i + 1).promise.catch(() => undefined);
        this.set({ phase: "playing", model: part.model });
        await this.play(part, i);
        if (this.controller.signal.aborted) return;
      }
      this.set({ phase: "done", progress: 1 });
    } catch (e) {
      this.waitingFor = -1;
      if (this.controller.signal.aborted || (e instanceof AiError && e.kind === "aborted")) return;
      this.failedAt = i;
      this.set({ phase: "failed", part: i + 1, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.finish();
    }
  }

  /** After a failure, carries on from the part that failed; earlier parts are not made again */
  retry(): void {
    if (this.state.phase !== "failed") return;
    void this.run(this.failedAt);
  }

  private play(part: AudioPart, i: number): Promise<void> {
    const ready = playable(part);
    const url = URL.createObjectURL(new Blob([ready.bytes], { type: ready.mime }));
    return new Promise<void>((resolve, reject) => {
      const a = new Audio(url);
      a.playbackRate = this.speech.rate;
      (a as HTMLAudioElement & { preservesPitch: boolean }).preservesPitch = true;
      this.audio = a;
      const end = () => {
        URL.revokeObjectURL(url);
        this.audio = null;
        this.stopPlayback = null;
      };
      a.ontimeupdate = () => {
        if (a.duration) this.state = { ...this.state, progress: (i + a.currentTime / a.duration) / this.chunks.length };
      };
      a.onended = () => {
        end();
        resolve();
      };
      a.onerror = () => {
        end();
        reject(new AiError("request", "The audio could not be played."));
      };
      this.stopPlayback = () => {
        a.pause();
        end();
        resolve();
      };
      a.play().catch((e: unknown) => {
        end();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  setRate(rate: number): void {
    if (this.audio) this.audio.playbackRate = rate;
  }

  pause(): void {
    if (this.state.phase !== "playing" || !this.audio) return;
    this.audio.pause();
    this.set({ phase: "paused" });
  }

  resume(): void {
    if (this.state.phase !== "paused" || !this.audio) return;
    void this.audio.play();
    this.set({ phase: "playing" });
  }

  stop(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.stopPlayback?.();
    this.set({ phase: "stopped" });
    this.finish();
  }

  get finished(): boolean {
    return ["done", "failed", "stopped"].includes(this.state.phase);
  }

  /** Makes every part that is still missing, joins them and saves one audio file */
  async save(): Promise<TFile> {
    const parts: AudioPart[] = [];
    this.set({ saving: { ready: 0 }, saved: "" });
    try {
      for (let i = 0; i < this.chunks.length; i++) {
        parts.push(await this.job(i).promise);
        this.set({ saving: { ready: i + 1 } });
      }
      const audio = joinAudio(parts);
      const app = this.speech.plugin.app;
      const name = `${sanitize(this.state.title) || "Speech"} ${moment().format("YYYY-MM-DD HH-mm")}.${audio.ext}`;
      const path = normalizePath(await app.fileManager.getAvailablePathForAttachment(name, this.opts.sourcePath ?? ""));
      const file = await app.vault.createBinary(path, audio.bytes.buffer.slice(audio.bytes.byteOffset, audio.bytes.byteOffset + audio.bytes.byteLength) as ArrayBuffer);
      this.opts.insertLink?.(app.fileManager.generateMarkdownLink(file, this.opts.sourcePath ?? ""));
      this.set({ saving: null, saved: file.path });
      return file;
    } catch (e) {
      this.set({ saving: null });
      throw e;
    }
  }
}

/** One voice at a time; the player bar and scripts follow it through onChange */
export class SpeechController {
  current: SpeechSession | null = null;
  private listeners = new Set<(s: SpeechState | null) => void>();

  constructor(readonly plugin: PromptShelfPlugin, private synth: Synthesizer) {}

  get rate(): number {
    return this.plugin.settings.speechRate || 1;
  }

  setRate(rate: number): void {
    this.plugin.settings.speechRate = rate;
    void this.plugin.saveData(this.plugin.settings);
    this.current?.setRate(rate);
    this.changed(this.current);
  }

  /** Same id and text after a failure picks up from the failed part */
  speak(text: string, opts: SpeakOptions = {}): SpeechSession {
    const prev = this.current;
    if (prev && prev.state.phase === "failed" && prev.state.id === (opts.id ?? "") && prev.text === text) {
      prev.retry();
      return prev;
    }
    prev?.stop();
    const session = new SpeechSession(this, this.synth, text, opts);
    if (session.empty) throw new AiError("input", "There is no text to read.");
    this.current = session;
    this.changed(session);
    void session.run();
    return session;
  }

  stop(): void {
    this.current?.stop();
  }

  dismiss(): void {
    this.current?.stop();
    this.current = null;
    this.changed(null);
  }

  state(): SpeechState | null {
    return this.current ? { ...this.current.state } : null;
  }

  onChange(cb: (s: SpeechState | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  changed(session: SpeechSession | null): void {
    if (session && session !== this.current) return;
    const s = this.state();
    for (const cb of this.listeners) {
      try {
        cb(s);
      } catch (e) {
        console.error("[prompt-shelf]", e);
      }
    }
  }
}
