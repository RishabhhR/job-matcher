const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type Message = { role: "system" | "user" | "assistant"; content: string };

interface LLMResult {
  offline: boolean;
  content: string;
  warning?: string;
  status?: number;
  retryAfterMs?: number;
}

// A cron process scores many batches in sequence. Once a provider/model reports
// a persistent configuration, access, billing, or quota error, don't spend the
// remaining run repeating the same doomed request for every batch.
const disabledProviders = new Map<string, number>();
const CIRCUIT_BREAKER_STATUSES = new Set([401, 402, 403, 404, 429]);
const CIRCUIT_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

function retryAfterMs(headers: Headers, body: string): number | undefined {
  const durationMs = (value: string): number | undefined => {
    const seconds = value.trim().match(/^(\d+(?:\.\d+)?)$/);
    if (seconds) return Math.ceil(Number(seconds[1]) * 1000);
    const pieces = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?)/gi)];
    if (!pieces.length) return undefined;
    return Math.ceil(pieces.reduce((total, match) => {
      const unit = match[2].toLowerCase();
      const multiplier = unit.startsWith("ms") ? 1
        : unit === "s" || unit.startsWith("sec") ? 1000
        : unit === "m" || unit.startsWith("min") ? 60_000
        : 3_600_000;
      return total + Number(match[1]) * multiplier;
    }, 0));
  };

  for (const name of ["retry-after", "x-ratelimit-reset", "x-ratelimit-reset-tokens"]) {
    const value = headers.get(name);
    if (value) {
      const parsed = durationMs(value);
      if (parsed !== undefined) return parsed;
      const dateDelay = Date.parse(value) - Date.now();
      if (Number.isFinite(dateDelay) && dateDelay > 0) return dateDelay;
    }
  }
  const bodyMatch = body.match(/(?:try again|retry)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?)\s*)+)/i);
  return bodyMatch ? durationMs(bodyMatch[1]) : undefined;
}

export class LLMProvidersUnavailableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "LLMProvidersUnavailableError";
  }
}

export function resetDisabledProviders(): void {
  disabledProviders.clear();
  resetGroqKeyCooldowns();
}

const groqKeyCooldowns = new Map<string, number>();
let groqKeyIndex = Math.floor(Math.random() * 100);

export function getAvailableGroqKeys(): string[] {
  const raw = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || "";
  return raw.split(",").map((k) => k.trim()).filter(Boolean);
}

export function resetGroqKeyCooldowns(): void {
  groqKeyCooldowns.clear();
  groqKeyIndex = 0;
}

export function getGroqKeyCooldowns(): Map<string, number> {
  return new Map(groqKeyCooldowns);
}

export function getDisabledProviders(): Map<string, number> {
  return new Map(disabledProviders);
}

export async function callWithCircuit(key: string, call: () => Promise<LLMResult>): Promise<LLMResult> {
  const provider = key.includes(":") ? key.split(":")[0] : key;
  const providerKey = `provider:${provider}`;

  const providerDisabledUntil = disabledProviders.get(providerKey);
  if (providerDisabledUntil && providerDisabledUntil > Date.now()) {
    return { offline: true, content: "", retryAfterMs: providerDisabledUntil - Date.now(), warning: `Provider ${provider} is cooling down` };
  }
  if (providerDisabledUntil) {
    disabledProviders.delete(providerKey);
  }

  const disabledUntil = disabledProviders.get(key);
  if (disabledUntil && disabledUntil > Date.now()) return { offline: true, content: "", retryAfterMs: disabledUntil - Date.now() };
  if (disabledUntil) {
    disabledProviders.delete(key);
  }
  const result = await call();
  if (result.status && CIRCUIT_BREAKER_STATUSES.has(result.status)) {
    const cooldownMs = result.status === 429
      ? result.retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS
      : CIRCUIT_COOLDOWN_MS;
    disabledProviders.set(key, Date.now() + cooldownMs);

    // Rate limits (429) or billing/credential errors (401, 402, 403) affect the entire
    // provider organization/account. Trip the provider circuit so subsequent models
    // on the same shared quota avoid doomed HTTP calls. 404 is model-specific.
    if (result.status !== 404) {
      disabledProviders.set(providerKey, Date.now() + cooldownMs);
    }

    if (result.status === 429) result.retryAfterMs = cooldownMs;
  }
  return result;
}

interface GroqOptions {
  temperature?: number;
  maxCompletionTokens?: number;
  topP?: number;
  reasoningEffort?: "none" | "default" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

async function callGroq(messages: Message[], model: string, timeoutMs = 60000, options: GroqOptions = {}, deadlineAt?: number): Promise<LLMResult> {
  const keys = getAvailableGroqKeys();
  if (!keys.length) return { offline: true, content: "" };

  const now = Date.now();
  let lastResult: LLMResult | null = null;
  let shortestCooldownMs: number | undefined;

  // Try available keys starting from the current rotating index
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const remainingBudget = deadlineAt === undefined ? timeoutMs : Math.min(timeoutMs, deadlineAt - Date.now());
    if (remainingBudget <= 0) return { offline: true, content: "", warning: "LLM scoring time budget exhausted" };
    const keyIdx = (groqKeyIndex + attempt) % keys.length;
    const apiKey = keys[keyIdx];
    const cooledUntil = groqKeyCooldowns.get(apiKey) || 0;

    if (cooledUntil > now) {
      const remaining = cooledUntil - now;
      if (shortestCooldownMs === undefined || remaining < shortestCooldownMs) {
        shortestCooldownMs = remaining;
      }
      continue;
    }

    // Found an active key
    groqKeyIndex = (keyIdx + 1) % keys.length;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingBudget);

    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // Groq/Cloudflare can reject requests with no recognizable user agent.
          "User-Agent": "job-matcher/1.0",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.2,
          response_format: { type: "json_object" },
          ...(options.maxCompletionTokens
            ? { max_completion_tokens: options.maxCompletionTokens }
            : { max_tokens: 4096 }),
          ...(options.topP !== undefined ? { top_p: options.topP } : {}),
          ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const retryAfter = res.status === 429 ? retryAfterMs(res.headers, body) : undefined;
        if (res.status === 429) {
          const cooldown = retryAfter ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
          groqKeyCooldowns.set(apiKey, Date.now() + cooldown);
          console.warn(`[ai] Groq key (${apiKey.slice(0, 8)}...) hit rate limit; cooling down for ${Math.round(cooldown / 1000)}s`);
        } else if (res.status === 401 || res.status === 402 || res.status === 403) {
          groqKeyCooldowns.set(apiKey, Date.now() + CIRCUIT_COOLDOWN_MS);
          console.warn(`[ai] Groq key (${apiKey.slice(0, 8)}...) rejected with HTTP ${res.status}; cooling down for 1h`);
        }
        lastResult = {
          offline: true,
          content: "",
          status: res.status,
          retryAfterMs: retryAfter,
          warning: `Groq HTTP ${res.status}: ${body.slice(0, 300)}`,
        };
        // If there are other keys configured, continue to try them!
        if (keys.length > 1) {
          continue;
        }
        return lastResult;
      }

      const data = await res.json();
      return { offline: false, content: data.choices[0].message.content };
    } catch {
      lastResult = { offline: true, content: "", warning: "Groq request failed or timed out" };
      if (keys.length > 1) continue;
      return lastResult;
    } finally {
      clearTimeout(timer);
    }
  }

  // All keys are either cooling down or failed
  return (
    lastResult || {
      offline: true,
      content: "",
      status: 429,
      retryAfterMs: shortestCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      warning: "All Groq API keys are currently rate-limited",
    }
  );
}

async function callGemini(systemPrompt: string, userPrompt: string, timeoutMs = 60000): Promise<LLMResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { offline: true, content: "", warning: "GEMINI_API_KEY not set" };

  const preferredModel = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const postToModel = async (model: string) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    return fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });
  };

  try {
    let res = await postToModel(preferredModel);
    // If the configured/default lite model returns 404 (not yet enabled on account), fall back to gemini-2.5-flash
    if (res.status === 404 && preferredModel !== "gemini-2.5-flash") {
      res = await postToModel("gemini-2.5-flash");
    }
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { offline: true, content: "", status: res.status, retryAfterMs: res.status === 429 ? retryAfterMs(res.headers, body) : undefined, warning: `Gemini HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) return { offline: true, content: "", warning: "Gemini response contained no candidate parts" };
    return { offline: false, content };
  } catch {
    clearTimeout(timer);
    return { offline: true, content: "", warning: "Gemini request failed or timed out" };
  }
}

async function callGitHubModels(messages: Message[], model?: string, timeoutMs = 60000): Promise<LLMResult> {
  const apiKey = process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN;
  if (!apiKey) return { offline: true, content: "", warning: "GITHUB_TOKEN / GITHUB_MODELS_TOKEN not set" };

  const targetModel = model || process.env.GITHUB_MODEL || "gpt-4o-mini";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://models.inference.ai.azure.com/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: targetModel,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        offline: true,
        content: "",
        status: res.status,
        retryAfterMs: res.status === 429 ? retryAfterMs(res.headers, body) : undefined,
        warning: `GitHub Models HTTP ${res.status}: ${body.slice(0, 300)}`
      };
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { offline: true, content: "", warning: "GitHub Models response contained no content" };
    return { offline: false, content };
  } catch {
    clearTimeout(timer);
    return { offline: true, content: "", warning: "GitHub Models request failed or timed out" };
  }
}

// Free OpenRouter models are slow: one 6-posting batch on nemotron-3.5-super took 100-255s
// (TASK-080). The timer stays armed until the body is read - clearing it once headers
// arrived let a stalled body hang a run indefinitely.
async function callOpenRouter(messages: Message[], model: string, timeoutMs = 300000): Promise<LLMResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { offline: true, content: "", warning: "OPENROUTER_API_KEY not set" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      clearTimeout(timer);
      return { offline: true, content: "", status: res.status, retryAfterMs: res.status === 429 ? retryAfterMs(res.headers, body) : undefined, warning: `OpenRouter HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
    clearTimeout(timer);
    return { offline: false, content: data.choices[0].message.content };
  } catch {
    clearTimeout(timer);
    return { offline: true, content: "", warning: "OpenRouter request failed or timed out" };
  }
}

async function callCerebras(messages: Message[], timeoutMs = 60000): Promise<LLMResult> {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) return { offline: true, content: "", warning: "CEREBRAS_API_KEY not set" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // "llama-3.3-70b" doesn't exist on Cerebras's free tier for this account -
        // confirmed via GET /v1/models the actual available models are gpt-oss-120b,
        // zai-glm-4.7, gemma-4-31b. gpt-oss-120b matches Cerebras's documented free
        // tier (1M tokens/day) and is the strongest of the three for this task.
        model: "gpt-oss-120b",
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
        max_tokens: 4096,
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { offline: true, content: "", status: res.status, retryAfterMs: res.status === 429 ? retryAfterMs(res.headers, body) : undefined, warning: `Cerebras HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
    return { offline: false, content: data.choices[0].message.content };
  } catch {
    clearTimeout(timer);
    return { offline: true, content: "", warning: "Cerebras request failed or timed out" };
  }
}

async function callMistral(messages: Message[], model: string, timeoutMs = 60000): Promise<LLMResult> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) return { offline: true, content: "", warning: "MISTRAL_API_KEY not set" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
        max_tokens: 4096,
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { offline: true, content: "", status: res.status, retryAfterMs: res.status === 429 ? retryAfterMs(res.headers, body) : undefined, warning: `Mistral HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
    return { offline: false, content: data.choices[0].message.content };
  } catch {
    clearTimeout(timer);
    return { offline: true, content: "", warning: "Mistral request failed or timed out" };
  }
}

export async function callLLM(messages: Message[], options: { timeoutMs?: number } = {}): Promise<{ content: string; provider: string; warning?: string }> {
  // Fallback chain: Groq gpt-oss-20b → Groq gpt-oss-120b → Mistral (ministral 14B,
  // then 8B) → Groq qwen → Gemini → OpenRouter → Cerebras. Keep stale model names out of
  // this chain: a decommissioned Groq default silently pushes every batch to Gemini.
  let shortestRetryAfterMs: number | undefined;
  const deadlineAt = options.timeoutMs ? Date.now() + options.timeoutMs : undefined;
  const remainingTimeout = () => deadlineAt === undefined ? undefined : Math.max(1, deadlineAt - Date.now());
  const noteRetry = (result: LLMResult) => {
    if (result.retryAfterMs !== undefined && (shortestRetryAfterMs === undefined || result.retryAfterMs < shortestRetryAfterMs)) {
      shortestRetryAfterMs = result.retryAfterMs;
    }
  };
  const primaryModel = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
  const primaryKey = `groq:${primaryModel}`;
  const groq = await callWithCircuit(primaryKey, () => callGroq(messages, primaryModel, remainingTimeout(), {}, deadlineAt));
  if (!groq.offline) return { content: groq.content, provider: "groq" };
  noteRetry(groq);
  if (groq.warning) console.warn(`[ai] groq (${primaryModel}): ${groq.warning}`);

  const groqFallbackModel = "openai/gpt-oss-120b";
  if (primaryModel !== groqFallbackModel) {
    const groqSmall = await callWithCircuit(`groq:${groqFallbackModel}`, () => callGroq(messages, groqFallbackModel, remainingTimeout(), {}, deadlineAt));
    if (!groqSmall.offline) return { content: groqSmall.content, provider: "groq-gpt-oss-120b", warning: "Used Groq GPT-OSS fallback model" };
    noteRetry(groqSmall);
    if (groqSmall.warning) console.warn(`[ai] groq (${groqFallbackModel}): ${groqSmall.warning}`);
  }

  // Mistral after both GPT-OSS models (TASK-074/077): the free plan allows ministral-14b-2512 937,500
  // tokens/min (30 req/min) and ministral-8b-2512 625,000 (188 req/min), vs Groq's
  // 6-12K, so it absorbs the load when both Groq models are throttled. It sits behind
  // gpt-oss-120b because its scores were noisier on real postings (mean 27 points off
  // stored scores across 12 postings).
  // mistral-small/medium get 0 req/min and mistral-large is 403 on the free plan.
  const mistralModels = [
    process.env.MISTRAL_MODEL || "ministral-14b-2512",
    process.env.MISTRAL_FALLBACK_MODEL || "ministral-8b-2512",
  ];
  for (const model of [...new Set(mistralModels)]) {
    if (deadlineAt !== undefined && deadlineAt <= Date.now()) break;
    const mistral = await callWithCircuit(`mistral:${model}`, () => callMistral(messages, model, remainingTimeout()));
    if (!mistral.offline) return { content: mistral.content, provider: `mistral-${model}`, warning: "Used Mistral fallback" };
    noteRetry(mistral);
    if (mistral.warning) console.warn(`[ai] mistral (${model}): ${mistral.warning}`);
  }

  const qwenModel = "qwen/qwen3.8-27b";
  const qwen = await callWithCircuit(`groq:${qwenModel}`, () => callGroq(messages, qwenModel, remainingTimeout(), {
    temperature: 0.6,
    maxCompletionTokens: 2048,
    topP: 0.95,
    reasoningEffort: "default",
  }, deadlineAt));
  if (!qwen.offline) return { content: qwen.content, provider: "groq-qwen3.8-27b", warning: "Used Groq Qwen 3.8 27B fallback model" };
  noteRetry(qwen);
  if (qwen.warning) console.warn(`[ai] groq (${qwenModel}): ${qwen.warning}`);

  const systemPrompt = messages.find((m) => m.role === "system")?.content || "";
  const userPrompt = messages.find((m) => m.role === "user")?.content || "";
  const gemini = deadlineAt !== undefined && deadlineAt <= Date.now()
    ? { offline: true, content: "" }
    : await callWithCircuit("gemini", () => callGemini(systemPrompt, userPrompt, remainingTimeout()));
  if (!gemini.offline) return { content: gemini.content, provider: "gemini", warning: "Used Gemini fallback" };
  noteRetry(gemini);
  if (gemini.warning) console.warn(`[ai] gemini: ${gemini.warning}`);

  // GitHub Models via Azure AI (free via GITHUB_TOKEN or GITHUB_MODELS_TOKEN)
  const ghModel = process.env.GITHUB_MODEL || "gpt-4o-mini";
  const gh = deadlineAt !== undefined && deadlineAt <= Date.now()
    ? { offline: true, content: "" }
    : await callWithCircuit(`github:${ghModel}`, () => callGitHubModels(messages, ghModel, remainingTimeout()));
  if (!gh.offline) return { content: gh.content, provider: `github-${ghModel}`, warning: "Used GitHub Models fallback" };
  noteRetry(gh);
  if (gh.warning) console.warn(`[ai] github (${ghModel}): ${gh.warning}`);

  // OpenRouter free tier (TASK-080): ~50 free-model requests/day, 20/min, failed attempts
  // count too - so each model has its own circuit breaker. Only ":free" models with JSON
  // mode; nemotron-3-super:free started returning 404 (provider gone) in Oct 2026.
  const openRouterModels = [
    process.env.OPENROUTER_MODEL || "nvidia/nemotron-3.5-super-vl:free",
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
  ];
  for (const model of [...new Set(openRouterModels)]) {
    if (deadlineAt !== undefined && deadlineAt <= Date.now()) break;
    const or = await callWithCircuit(`openrouter:${model}`, () => callOpenRouter(messages, model, remainingTimeout()));
    if (!or.offline) return { content: or.content, provider: `openrouter-${model}`, warning: "Used OpenRouter fallback" };
    noteRetry(or);
    if (or.warning) console.warn(`[ai] openrouter (${model}): ${or.warning}`);
  }

  // Cerebras' free tier now needs a card (HTTP 402); kept last so a paid key still works.
  const cerebras = deadlineAt !== undefined && deadlineAt <= Date.now()
    ? { offline: true, content: "" }
    : await callWithCircuit("cerebras", () => callCerebras(messages, remainingTimeout()));
  if (!cerebras.offline) return { content: cerebras.content, provider: "cerebras", warning: "Used Cerebras fallback" };
  noteRetry(cerebras);
  if (cerebras.warning) console.warn(`[ai] cerebras: ${cerebras.warning}`);

  const reason = shortestRetryAfterMs === undefined
    ? "All LLM providers rejected or could not complete the request. Check provider configuration, billing, model availability, and rate limits."
    : "All LLM providers are currently rate-limited or quota-exhausted.";
  throw new LLMProvidersUnavailableError(reason, shortestRetryAfterMs);
}

export function parseJSON<T>(content: string, fallback: T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        /* fall through */
      }
    }
    return fallback;
  }
}
