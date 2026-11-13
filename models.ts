export const AI_MODELS = [
  {
    id: "auto/smart",
    name: "OmniRoute Dynamic Smart",
    role: "dynamic",
  },
  {
    id: "auto/best-reasoning",
    name: "OmniRoute Auto - Best Reasoning",
    role: "advanced-reasoning",
  },
  {
    id: "auto/best-coding",
    name: "OmniRoute Auto - Best Coding",
    role: "coding-and-reasoning",
  },
  {
    id: "auto/best-fast",
    name: "OmniRoute Auto - Best Fast",
    role: "fast",
  },
  {
    id: "agy/claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 Thinking",
    role: "advanced-reasoning",
  },
  {
    id: "agy/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    role: "balanced",
  },
  {
    id: "agy/gemini-3.8-flash-tiered",
    name: "Gemini 3.8 Flash",
    role: "fast",
  },
  {
    id: "codex/gpt-6-luna",
    name: "GPT-6 Luna",
    role: "coding-and-reasoning",
  },
] as const;

export type AIModelId = (typeof AI_MODELS)[number]["id"];

export function isAllowedModel(value: string): value is AIModelId {
  return AI_MODELS.some((model) => model.id === value);
}

export const DEFAULT_AI_MODEL: AIModelId = "auto/smart";