import { Notice } from "obsidian";
import { SpeechController, SpeechState } from "../speech/session";

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SLOW_SECONDS = 40;
const HIDE_AFTER_MS = 8000;

const secondsSince = (t: number) => Math.max(0, Math.round((Date.now() - t) / 1000));
const secondsUntil = (t: number) => Math.max(0, Math.ceil((t - Date.now()) / 1000));

/** What is happening right now, in one line */
export function describe(s: SpeechState): string {
  const of = `part ${s.part} of ${s.total}`;
  const provider = s.model.split(" · ")[0] || "The provider";
  let line: string;
  switch (s.phase) {
    case "preparing": {
      const secs = secondsSince(s.since);
      line = `Preparing ${of} · ${secs} s${secs >= SLOW_SECONDS ? " — slower than usual" : ""}`;
      break;
    }
    case "waiting":
      line = `${provider} quota is full · retrying in ${secondsUntil(s.until)} s · ${of}`;
      break;
    case "playing":
      line = `Playing ${of}`;
      break;
    case "paused":
      line = `Paused · ${of}`;
      break;
    case "done":
      line = s.total > 1 ? `Finished all ${s.total} parts` : "Finished";
      break;
    case "failed":
      line = `Part ${s.part} of ${s.total} failed: ${s.error}`;
      break;
    default:
      line = "Stopped";
  }
  if (s.saving) line += ` · Saving audio: ${s.saving.ready} of ${s.total} parts ready`;
  else if (s.saved) line += ` · Saved to ${s.saved}`;
  return line;
}

/** A small floating bar that follows the current speech session */
export class PlayerBar {
  private el: HTMLElement | null = null;
  private status!: HTMLElement;
  private fill!: HTMLElement;
  private toggle!: HTMLButtonElement;
  private retry!: HTMLButtonElement;
  private save!: HTMLButtonElement;
  private rate!: HTMLSelectElement;
  private title!: HTMLElement;
  private ticker = 0;
  private hideTimer = 0;
  private off: () => void;

  constructor(private speech: SpeechController) {
    this.off = speech.onChange((s) => this.render(s));
  }

  destroy(): void {
    this.off();
    window.clearInterval(this.ticker);
    window.clearTimeout(this.hideTimer);
    this.el?.remove();
    this.el = null;
  }

  private build(): HTMLElement {
    const el = activeDocument.body.createDiv({ cls: "psh-player" });
    const top = el.createDiv({ cls: "psh-row psh-player-top" });
    this.title = top.createSpan({ cls: "psh-player-title" });
    const close = top.createEl("button", { cls: "psh-player-close", text: "×", attr: { "aria-label": "Stop and close" } });
    close.onclick = () => this.speech.dismiss();

    this.status = el.createDiv({ cls: "psh-player-status" });
    this.fill = el.createDiv({ cls: "psh-player-track" }).createDiv({ cls: "psh-player-fill" });

    const row = el.createDiv({ cls: "psh-row psh-player-controls" });
    this.toggle = row.createEl("button");
    this.toggle.onclick = () => {
      const cur = this.speech.current;
      if (!cur) return;
      if (cur.state.phase === "paused") cur.resume();
      else if (cur.state.phase === "playing") cur.pause();
      else if (cur.finished && cur.state.phase !== "failed") this.speech.speak(cur.text, { id: cur.state.id, title: cur.state.title });
    };
    this.retry = row.createEl("button", { cls: "mod-cta", text: "Retry" });
    this.retry.onclick = () => this.speech.retry();
    this.rate = row.createEl("select", { cls: "dropdown" });
    for (const r of RATES) this.rate.createEl("option", { value: String(r), text: `${r}×` });
    this.rate.onchange = () => this.speech.setRate(Number(this.rate.value));
    this.save = row.createEl("button", { text: "Save audio" });
    this.save.onclick = async () => {
      const cur = this.speech.current;
      if (!cur) return;
      try {
        const file = await cur.save();
        new Notice(`Audio saved to ${file.path}`);
      } catch (e) {
        new Notice(`Could not save the audio: ${e instanceof Error ? e.message : String(e)}`, 10000);
      }
    };
    const stop = row.createEl("button", { text: "Stop" });
    stop.onclick = () => this.speech.stop();
    return el;
  }

  private render(s: SpeechState | null): void {
    window.clearTimeout(this.hideTimer);
    if (!s) {
      window.clearInterval(this.ticker);
      this.el?.remove();
      this.el = null;
      return;
    }
    if (!this.el) this.el = this.build();
    this.title.setText(s.title || "Read aloud");
    this.title.setAttr("title", s.model ? `${s.title} · ${s.model}` : s.title);
    this.status.setText(describe(s));
    this.status.toggleClass("psh-player-error", s.phase === "failed");
    this.fill.setCssProps({ "--psh-progress": `${Math.round(s.progress * 100)}%` });

    this.toggle.setText(s.phase === "paused" ? "Play" : s.phase === "playing" ? "Pause" : "Read again");
    this.toggle.disabled = s.phase === "preparing" || s.phase === "waiting" || s.phase === "failed";
    this.retry.toggleClass("psh-hidden", s.phase !== "failed");
    this.save.disabled = Boolean(s.saving);
    this.rate.value = String(this.speech.rate);

    const live = s.phase === "preparing" || s.phase === "waiting" || s.phase === "playing" || Boolean(s.saving);
    window.clearInterval(this.ticker);
    if (live) this.ticker = window.setInterval(() => {
      const cur = this.speech.state();
      if (cur) {
        this.status.setText(describe(cur));
        this.fill.setCssProps({ "--psh-progress": `${Math.round(cur.progress * 100)}%` });
      }
    }, 1000);
    if ((s.phase === "done" || s.phase === "stopped") && !s.saving) {
      this.hideTimer = window.setTimeout(() => {
        if (this.speech.current?.finished && !this.speech.current.state.saving) this.speech.dismiss();
      }, HIDE_AFTER_MS);
    }
  }
}
