/**
 * CrofAI provider for pi (https://crof.ai — "nahcrof")
 *
 * Implements CrofAI's OpenAI-compatible endpoint per https://crof.ai/docs:
 *
 *   - Chat Completions: https://crof.ai/v1/chat/completions  (`openai-completions`)
 *   - Models list:      GET https://crof.ai/v1/models        (public, no auth required)
 *
 * (CrofAI also exposes a Responses API at /v1/responses, but chat completions is
 * their primary documented endpoint and the fully featured path — reasoning_effort
 * control, strict tools, structured outputs — so it's the single provider this
 * package registers.)
 *
 * Authentication (`/login` flow via envApiKeyAuth):
 *   - `/login crofai` prompts for the API key and
 *     stores it in ~/.pi/agent/auth.json.
 *   - Resolution order per request: stored credential -> $CROFAI_API_KEY -> unconfigured.
 *
 * CrofAI quirks handled here:
 *   - `reasoning_effort` is a top-level request param with values "low" | "medium" | "high" | "none".
 *     "none" disables the thinking phase entirely (their docs). The thinking-level
 *     map below hides minimal/xhigh/max (null), so /reasoning offers exactly the four
 *     levels CrofAI supports instead of redundant aliases.
 *   - Thinking text streams in `delta.reasoning_content` — pi's `openai-completions`
 *     implementation reads that natively, no compat flag needed.
 *   - `max_tokens` and `max_completion_tokens` both work; `max_completion_tokens` wins.
 *   - `/v1/models` returns live pricing ($/M) plus `reasoning_effort` / `custom_reasoning`
 *     capability flags, so model metadata is discovered automatically on every pi start
 *     (and on /reload), with a static snapshot as offline fallback.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createProvider,
  envApiKeyAuth,
  type Model,
  type ModelCost,
} from "@earendil-works/pi-ai/compat";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

const BASE_URL = "https://crof.ai/v1";
const MODELS_URL = "https://crof.ai/v1/models";
const FALLBACK_MODEL_TIMEOUT_MS = 8_000;
const API_KEY_ENV_VARS = ["CROFAI_API_KEY"] as const;

/**
 * Vision-capable model ids. /v1/models doesn't advertise vision support;
 * this is the (vision) tag list from https://crof.ai/pricing, kept as an
 * allowlist for the `input` field. Unknown/new models default to text-only.
 */
const VISION_MODEL_IDS = new Set<string>([
  "kimi-k2.6",
  "kimi-k2.6-precision",
  "kimi-k2.5",
  "kimi-k2.5-lightning",
  "qwen3.6-27b",
  "qwen3.5-397b-a17b",
  "gemma-4-31b-it",
  "qwen3.5-9b",
  "greg-1-mini",
  "greg-1",
  "greg-1-super",
]);

/**
 * Maps pi thinking levels to CrofAI's `reasoning_effort` values.
 * CrofAI accepts exactly "low" | "medium" | "high" | "none":
 *   - "none" disables reasoning entirely (documented; saves latency/cost)
 *   - there is no xhigh/max tier and no separate minimal tier upstream, so
 *     minimal/xhigh/max are hidden (null) — /reasoning shows off/low/medium/high
 *     only, and any clamped selection lands on the nearest supported level.
 */
const THINKING_LEVEL_MAP = {
  off: "none",
  minimal: null, // hidden: would alias "low"
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null, // hidden: would alias "high"
  max: null,   // hidden: would alias "high"
} as const;

/**
 * Compat for chat completions models. Justification per CrofAI docs:
 *   - supportsDeveloperRole: false — CrofAI routes across many open-source
 *     backends; "system" is the universally accepted role.
 *   - supportsReasoningEffort: true — top-level `reasoning_effort` per docs.
 *   - supportsStrictMode: true — their tool examples use `"strict": true`.
 *   - maxTokensField: "max_completion_tokens" — docs: this alias wins.
 *   - supportsUsageInStreaming: true — standard OpenAI-compatible include_usage.
 *   - thinkingFormat: "openai" — top-level `reasoning_effort` field.
 */
const CHAT_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  supportsFinishReason: true,
  supportsStrictMode: true,
  maxTokensField: "max_completion_tokens",
  thinkingFormat: "openai",
} as const;

/** Minimal shape of a /v1/models entry (https://crof.ai/docs -> /models API). */
interface CrofAIAPIModel {
  id: string;
  name?: string;
  context_length?: number | string;
  max_completion_tokens?: number | string;
  reasoning_effort?: boolean;
  custom_reasoning?: boolean;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
    cache_prompt?: string | number;
  };
}

function toUSDPerM(value: string | number | undefined): number {
  const n = typeof value === "string" ? parseFloat(value) : (value as number);
  return Number.isFinite(n) ? n : 0;
}

type CrofAIApi = "openai-completions";

/** Build a native pi-ai Model for one CrofAI API model entry. */
function toModelConfig(m: CrofAIAPIModel): Model<CrofAIApi> {
  // reasoning_effort: true is CrofAI's own capability flag: it means the model
  // accepts the reasoning_effort param. (greg models use always-on "custom
  // reasoning" without the param — their reasoning_content deltas still stream
  // as thinking blocks in pi, but pi won't send reasoning_effort for them.)
  const reasoning = m.reasoning_effort === true;
  const cost: ModelCost = {
    input: toUSDPerM(m.pricing?.prompt),
    output: toUSDPerM(m.pricing?.completion),
    cacheRead: toUSDPerM(m.pricing?.cache_prompt),
    cacheWrite: 0, // CrofAI does not report cache-write pricing
  };
  return {
    id: m.id,
    name: m.name ?? m.id,
    api: "openai-completions",
    provider: "crofai",
    baseUrl: BASE_URL,
    reasoning,
    // Only reasoning_effort-capable models get the thinking level map, so
    // pi never sends reasoning_effort to models that don't accept it.
    thinkingLevelMap: reasoning ? THINKING_LEVEL_MAP : undefined,
    input: (VISION_MODEL_IDS.has(m.id) ? ["text", "image"] : ["text"]) as Array<"text" | "image">,
    cost,
    contextWindow: Number(m.context_length) || 128_000,
    maxTokens: Number(m.max_completion_tokens) || 8_192,
    compat: { ...CHAT_COMPAT },
  };
}

/**
 * Static snapshot of GET https://crof.ai/v1/models (fetched live at
 * development time). Used only when the endpoint is unreachable, so pi
 * startup never blocks on the network. The live list auto-refreshes on
 * every pi start / /reload.
 */
const FALLBACK_MODELS: CrofAIAPIModel[] = [
  { id: "deepseek-v4-pro-0813", name: "DeepSeek: DeepSeek V4 Pro 0813", context_length: 1_000_000, max_completion_tokens: 131_072, reasoning_effort: true, pricing: { prompt: "0.35", completion: "0.80", cache_prompt: "0.01" } },
  { id: "deepseek-v4-pro", name: "DeepSeek: DeepSeek V4 Pro", context_length: 1_000_000, max_completion_tokens: 131_072, reasoning_effort: true, pricing: { prompt: "0.35", completion: "0.80", cache_prompt: "0.003" } },
  { id: "deepseek-v4-flash-0731", name: "DeepSeek: DeepSeek V4 Flash 0731", context_length: 1_000_000, max_completion_tokens: 131_072, reasoning_effort: true, pricing: { prompt: "0.08", completion: "0.10", cache_prompt: "0.003" } },
  { id: "deepseek-v4-flash", name: "DeepSeek: DeepSeek V4 Flash", context_length: 1_000_000, max_completion_tokens: 131_072, reasoning_effort: true, pricing: { prompt: "0.12", completion: "0.21", cache_prompt: "0.003" } },
  { id: "deepseek-v3.2", name: "DeepSeek: DeepSeek V3.2", context_length: 163_840, max_completion_tokens: 163_840, pricing: { prompt: "0.18", completion: "0.35", cache_prompt: "0.04" } },
  { id: "kimi-k3", name: "MoonshotAI: Kimi K3", context_length: 1_000_000, max_completion_tokens: 262_144, reasoning_effort: true, pricing: { prompt: "2.00", completion: "8.00", cache_prompt: "0.25" } },
  { id: "kimi-k3-eco", name: "MoonshotAI: Kimi K3 (Eco)", context_length: 1_000_000, max_completion_tokens: 131_072, reasoning_effort: true, pricing: { prompt: "1.00", completion: "4.00", cache_prompt: "0.10" } },
  { id: "kimi-k2.7-code", name: "MoonshotAI: Kimi K2.7 Code", context_length: 262_144, max_completion_tokens: 262_144, reasoning_effort: true, pricing: { prompt: "0.55", completion: "2.25", cache_prompt: "0.05" } },
  { id: "kimi-k2.6", name: "MoonshotAI: Kimi K2.6", context_length: 262_144, max_completion_tokens: 262_144, reasoning_effort: true, pricing: { prompt: "0.50", completion: "1.99", cache_prompt: "0.05" } },
  { id: "glm-5.3", name: "Z.ai: GLM 5.3", context_length: 1_000_000, max_completion_tokens: 131_072, reasoning_effort: true, pricing: { prompt: "0.40", completion: "1.40", cache_prompt: "0.06" } },
  { id: "glm-5.3-flash", name: "Z.ai: GLM 5.3 Flash", context_length: 1_000_000, max_completion_tokens: 131_072, reasoning_effort: true, pricing: { prompt: "0.07", completion: "0.22", cache_prompt: "0.01" } },
  { id: "glm-5.2", name: "Z.ai: GLM 5.2", context_length: 1_000_000, max_completion_tokens: 131_072, reasoning_effort: true, pricing: { prompt: "0.30", completion: "1.05", cache_prompt: "0.05" } },
  { id: "glm-5.1", name: "Z.ai: GLM 5.1", context_length: 202_752, max_completion_tokens: 202_752, reasoning_effort: true, pricing: { prompt: "0.45", completion: "2.15", cache_prompt: "0.08" } },
  { id: "greg-2-ultra", name: "Crof: Greg 2 Ultra", context_length: 229_376, max_completion_tokens: 229_376, pricing: { prompt: "3.00", completion: "10.00", cache_prompt: "0.50" } },
  { id: "greg-2-super", name: "Crof: Greg 2 Super", context_length: 229_376, max_completion_tokens: 229_376, pricing: { prompt: "1.50", completion: "5.00", cache_prompt: "0.25" } },
  { id: "greg-1-mini", name: "Crof: Greg 1 Mini", context_length: 229_376, max_completion_tokens: 229_376, pricing: { prompt: "0.07", completion: "0.15", cache_prompt: "0.01" } },
  { id: "greg-rp", name: "Crof: Greg (Roleplay)", context_length: 229_376, max_completion_tokens: 229_376, pricing: { prompt: "0.10", completion: "0.30", cache_prompt: "0.02" } },
  { id: "mimo-v2.5-pro", name: "Xiaomi: MiMo-V2.5-Pro", context_length: 1_000_000, max_completion_tokens: 131_072, reasoning_effort: true, pricing: { prompt: "0.40", completion: "0.80", cache_prompt: "0.003" } },
  { id: "gemma-4-31b-it", name: "Google: Gemma 4 31B", context_length: 262_144, max_completion_tokens: 262_144, reasoning_effort: true, pricing: { prompt: "0.10", completion: "0.30", cache_prompt: "0.02" } },
  { id: "qwen3.8-27b", name: "Qwen: Qwen3.8 27B", context_length: 262_144, max_completion_tokens: 262_144, reasoning_effort: true, pricing: { prompt: "0.09", completion: "0.30", cache_prompt: "0.01" } },
  { id: "qwen3.6-27b", name: "Qwen: Qwen3.6 27B", context_length: 262_144, max_completion_tokens: 262_144, reasoning_effort: true, pricing: { prompt: "0.20", completion: "1.50", cache_prompt: "0.04" } },
  { id: "qwen3.5-397b-a17b", name: "Qwen: Qwen3.5 397B A17B", context_length: 262_144, max_completion_tokens: 262_144, reasoning_effort: true, pricing: { prompt: "0.35", completion: "1.75", cache_prompt: "0.07" } },
  { id: "qwen3.5-9b", name: "Qwen: Qwen3.5 9B", context_length: 262_144, max_completion_tokens: 262_144, reasoning_effort: true, pricing: { prompt: "0.04", completion: "0.15", cache_prompt: "0.008" } },
];

async function fetchCrofAIModels(): Promise<CrofAIAPIModel[] | undefined> {
  try {
    const res = await fetch(MODELS_URL, {
      signal: AbortSignal.timeout(FALLBACK_MODEL_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return undefined;
    const payload = (await res.json()) as { data?: CrofAIAPIModel[] };
    const models = payload.data?.filter((m) => typeof m?.id === "string" && m.id.length > 0);
    return models && models.length > 0 ? models : undefined;
  } catch {
    return undefined; // offline / timeout -> static snapshot
  }
}

export default async function (pi: ExtensionAPI) {
  const [liveModels, fallbackModels] = await Promise.all([
    fetchCrofAIModels(),
    Promise.resolve(FALLBACK_MODELS),
  ]);
  const apiModels = liveModels ?? fallbackModels;

  // Chat Completions endpoint (https://crof.ai/v1/chat/completions).
  // /login crofai -> secret prompt, stored in ~/.pi/agent/auth.json;
  // stored credential wins, otherwise $CROFAI_API_KEY, otherwise unconfigured.
  pi.registerProvider(
    createProvider({
      id: "crofai",
      name: "CrofAI",
      baseUrl: BASE_URL,
      auth: { apiKey: envApiKeyAuth("CrofAI API key", API_KEY_ENV_VARS) },
      models: apiModels.map((m) => toModelConfig(m)),
      api: openAICompletionsApi(),
    }),
  );
}