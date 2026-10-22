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

async function callWithCircuit(key: string, call: () => Promise<LLMResult>): Promise<LLMResult> {
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

async function callGroq(messages: Message[], model: string, timeoutMs = 60000, options: GroqOptions = {}): Promise<LLMResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { offline: true, content: "" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { offline: true, content: "", status: res.status, retryAfterMs: res.status === 429 ? retryAfterMs(res.headers, body) : undefined, warning: `Groq HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
    return { offline: false, content: data.choices[0].message.content };
  } catch {
    clearTimeout(timer);
    return { offline: true, content: "", warning: "Groq request failed or timed out" };
  }
}

async function callGemini(systemPrompt: string, userPrompt: string, timeoutMs = 60000): Promise<LLMResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { offline: true, content: "", warning: "GEMINI_API_KEY not set" };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { offline: true, content: "", status: res.status, retryAfterMs: res.status === 429 ? retryAfterMs(res.headers, body) : undefined, warning: `Gemini HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
    const content = data.candidates[0].content.parts[0].text;
    return { offline: false, content };
  } catch {
    clearTimeout(timer);
    return { offline: true, content: "", warning: "Gemini request failed or timed out" };
  }
}

async function callOpenRouter(messages: Message[], timeoutMs = 30000): Promise<LLMResult> {
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
        // "mistralai/mistral-7b-instruct" isn't a free model - would fail (or charge)
        // on a $0-balance account. Confirmed via GET /v1/models that this is a current
        // ":free" model with declared JSON-mode support. qwen3-next-80b was tried
        // first but its upstream provider (Venice) was persistently 429-ing as
        // oversubscribed; nemotron-3-super's upstream (Nvidia) responded cleanly.
        model: "nvidia/nemotron-3-super-120b-a12b:free",
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { offline: true, content: "", status: res.status, retryAfterMs: res.status === 429 ? retryAfterMs(res.headers, body) : undefined, warning: `OpenRouter HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
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

export async function callLLM(messages: Message[]): Promise<{ content: string; provider: string; warning?: string }> {
  // Fallback chain: Groq gpt-oss-20b → Groq gpt-oss-120b → Mistral (ministral 14B,
  // then 8B) → Groq qwen → Gemini → OpenRouter → Cerebras. Keep stale model names out of
  // this chain: a decommissioned Groq default silently pushes every batch to Gemini.
  let shortestRetryAfterMs: number | undefined;
  const noteRetry = (result: LLMResult) => {
    if (result.retryAfterMs !== undefined && (shortestRetryAfterMs === undefined || result.retryAfterMs < shortestRetryAfterMs)) {
      shortestRetryAfterMs = result.retryAfterMs;
    }
  };
  const primaryModel = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
  const primaryKey = `groq:${primaryModel}`;
  const groq = await callWithCircuit(primaryKey, () => callGroq(messages, primaryModel));
  if (!groq.offline) return { content: groq.content, provider: "groq" };
  noteRetry(groq);
  if (groq.warning) console.warn(`[ai] groq (${primaryModel}): ${groq.warning}`);

  const groqFallbackModel = "openai/gpt-oss-120b";
  if (primaryModel !== groqFallbackModel) {
    const groqSmall = await callWithCircuit(`groq:${groqFallbackModel}`, () => callGroq(messages, groqFallbackModel));
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
    const mistral = await callWithCircuit(`mistral:${model}`, () => callMistral(messages, model));
    if (!mistral.offline) return { content: mistral.content, provider: `mistral-${model}`, warning: "Used Mistral fallback" };
    noteRetry(mistral);
    if (mistral.warning) console.warn(`[ai] mistral (${model}): ${mistral.warning}`);
  }

  const qwenModel = "qwen/qwen3.8-27b";
  const qwen = await callWithCircuit(`groq:${qwenModel}`, () => callGroq(messages, qwenModel, 60000, {
    temperature: 0.6,
    maxCompletionTokens: 2048,
    topP: 0.95,
    reasoningEffort: "default",
  }));
  if (!qwen.offline) return { content: qwen.content, provider: "groq-qwen3.8-27b", warning: "Used Groq Qwen 3.8 27B fallback model" };
  noteRetry(qwen);
  if (qwen.warning) console.warn(`[ai] groq (${qwenModel}): ${qwen.warning}`);

  const systemPrompt = messages.find((m) => m.role === "system")?.content || "";
  const userPrompt = messages.find((m) => m.role === "user")?.content || "";
  const gemini = await callWithCircuit("gemini", () => callGemini(systemPrompt, userPrompt));
  if (!gemini.offline) return { content: gemini.content, provider: "gemini", warning: "Used Gemini fallback" };
  noteRetry(gemini);
  if (gemini.warning) console.warn(`[ai] gemini: ${gemini.warning}`);

  const or = await callWithCircuit("openrouter", () => callOpenRouter(messages));
  if (!or.offline) return { content: or.content, provider: "openrouter", warning: "Used OpenRouter fallback" };
  noteRetry(or);
  if (or.warning) console.warn(`[ai] openrouter: ${or.warning}`);

  // Cerebras' free tier now needs a card (HTTP 402); kept last so a paid key still works.
  const cerebras = await callWithCircuit("cerebras", () => callCerebras(messages));
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
