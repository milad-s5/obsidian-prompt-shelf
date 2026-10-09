export type ProviderType = "openai" | "anthropic" | "gemini";

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  models: string[];
}

export interface Action {
  id: string;
  name: string;
  model: string;
  system: string;
  prompt: string;
  mergePrompt: string;
}

export interface PanelState {
  action: string;
  model: string;
}

export interface AiActionsSettings {
  providers: Provider[];
  defaultModel: string;
  fallbackModels: string[];
  language: string;
  actions: Action[];
  chunkChars: number;
  maxTokens: number;
  timeoutSec: number;
  panels: Record<string, PanelState>;
}

export interface ProviderPreset {
  name: string;
  type: ProviderType;
  baseUrl: string;
  models: string[];
}

export const PROVIDER_TYPES: Record<ProviderType, string> = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
};

export const PRESETS: ProviderPreset[] = [
  { name: "OpenRouter", type: "openai", baseUrl: "https://openrouter.ai/api/v1", models: ["openrouter/free"] },
  { name: "Google Gemini", type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: ["gemini-flash-latest"] },
  { name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", models: ["gpt-5-mini"] },
  { name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com/v1", models: ["claude-haiku-5-5"] },
  { name: "DeepSeek", type: "openai", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat"] },
  { name: "Groq", type: "openai", baseUrl: "https://api.groq.com/openai/v1", models: [] },
  { name: "Ollama (local)", type: "openai", baseUrl: "http://localhost:11434/v1", models: [] },
  { name: "Custom (OpenAI-compatible)", type: "openai", baseUrl: "", models: [] },
];

export const DEFAULT_ACTIONS: Action[] = [
  {
    id: "summarize",
    name: "Summarize",
    model: "",
    system: "You summarize texts accurately and write in natural, fluent {{language}}. Use only what the text says.",
    prompt:
      "Summarize the text below in {{language}}. It may be an auto-generated video transcript, so punctuation can be missing and some words misheard.\n" +
      "Title: {{title}}\n\n" +
      "Format:\n" +
      "- One short paragraph with the main idea\n" +
      "- Key points as a bulleted list\n" +
      "- Practical takeaways, if there are any, in their own list\n\n" +
      "Text:\n{{text}}",
    mergePrompt:
      "These are summaries of consecutive parts of one long text. Merge them into a single coherent summary in {{language}} with the same format, and drop repetition.\n\n{{text}}",
  },
  {
    id: "translate",
    name: "Translate",
    model: "",
    system: "You are a professional translator into {{language}}.",
    prompt:
      "Translate the text below into natural {{language}}. If it lacks punctuation, add punctuation and paragraphs. Reply with the translation only.\n\n{{text}}",
    mergePrompt: "",
  },
  {
    id: "clean-transcript",
    name: "Clean up transcript",
    model: "",
    system: "",
    prompt:
      "The text below is an auto-generated video transcript. Without summarizing and without changing its language, add punctuation and paragraphs, fix obvious mishearings, and add short headings for sections. Reply with the final text only.\n\n{{text}}",
    mergePrompt: "",
  },
];

export const DEFAULT_SETTINGS: AiActionsSettings = {
  providers: [],
  defaultModel: "",
  fallbackModels: [],
  language: "English",
  actions: DEFAULT_ACTIONS,
  chunkChars: 40000,
  maxTokens: 16000,
  timeoutSec: 180,
  panels: {},
};
