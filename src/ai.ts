const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type Message = { role: "system" | "user" | "assistant"; content: string };

interface LLMResult {
  offline: boolean;
  content: string;
  warning?: string;
  status?: number;
}

// A cron process scores many batches in sequence. Once a provider/model reports
// a persistent configuration, access, billing, or quota error, don't spend the
// remaining run repeating the same doomed request for every batch.
const disabledProviders = new Set<string>();
const CIRCUIT_BREAKER_STATUSES = new Set([401, 402, 403, 404, 429]);

async function callWithCircuit(key: string, call: () => Promise<LLMResult>): Promise<LLMResult> {
  if (disabledProviders.has(key)) {
    return { offline: true, content: "" };
  }
  const result = await call();
  if (result.status && CIRCUIT_BREAKER_STATUSES.has(result.status)) disabledProviders.add(key);
  return result;
}

async function callGroq(messages: Message[], model: string, timeoutMs = 60000): Promise<LLMResult> {
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
        temperature: 0.2,
        response_format: { type: "json_object" },
        max_tokens: 4096,
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { offline: true, content: "", status: res.status, warning: `Groq HTTP ${res.status}: ${body.slice(0, 300)}` };
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
      return { offline: true, content: "", status: res.status, warning: `Gemini HTTP ${res.status}: ${body.slice(0, 300)}` };
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
      return { offline: true, content: "", status: res.status, warning: `OpenRouter HTTP ${res.status}: ${body.slice(0, 300)}` };
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
      return { offline: true, content: "", status: res.status, warning: `Cerebras HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
    return { offline: false, content: data.choices[0].message.content };
  } catch {
    clearTimeout(timer);
    return { offline: true, content: "", warning: "Cerebras request failed or timed out" };
  }
}

async function callMistral(messages: Message[], timeoutMs = 60000): Promise<LLMResult> {
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
        model: "mistral-small-latest",
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
        max_tokens: 4096,
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { offline: true, content: "", status: res.status, warning: `Mistral HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
    return { offline: false, content: data.choices[0].message.content };
  } catch {
    clearTimeout(timer);
    return { offline: true, content: "", warning: "Mistral request failed or timed out" };
  }
}

export async function callLLM(messages: Message[]): Promise<{ content: string; provider: string; warning?: string }> {
  // Fallback chain: current Groq chat model → a second current Groq chat model
  // → Gemini → Cerebras → Mistral → OpenRouter. Keep stale model names out of
  // this chain: a decommissioned Groq default silently pushes every batch to Gemini.
  const primaryModel = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
  const primaryKey = `groq:${primaryModel}`;
  const groq = await callWithCircuit(primaryKey, () => callGroq(messages, primaryModel));
  if (!groq.offline) return { content: groq.content, provider: "groq" };
  if (groq.warning) console.warn(`[ai] groq (${primaryModel}): ${groq.warning}`);

  const groqFallbackModel = "openai/gpt-oss-120b";
  if (primaryModel !== groqFallbackModel) {
    const groqSmall = await callWithCircuit(`groq:${groqFallbackModel}`, () => callGroq(messages, groqFallbackModel));
    if (!groqSmall.offline) return { content: groqSmall.content, provider: "groq-gpt-oss-120b", warning: "Used Groq GPT-OSS fallback model" };
    if (groqSmall.warning) console.warn(`[ai] groq (${groqFallbackModel}): ${groqSmall.warning}`);
  }

  const systemPrompt = messages.find((m) => m.role === "system")?.content || "";
  const userPrompt = messages.find((m) => m.role === "user")?.content || "";
  const gemini = await callWithCircuit("gemini", () => callGemini(systemPrompt, userPrompt));
  if (!gemini.offline) return { content: gemini.content, provider: "gemini", warning: "Used Gemini fallback" };
  if (gemini.warning) console.warn(`[ai] gemini: ${gemini.warning}`);

  const cerebras = await callWithCircuit("cerebras", () => callCerebras(messages));
  if (!cerebras.offline) return { content: cerebras.content, provider: "cerebras", warning: "Used Cerebras fallback" };
  if (cerebras.warning) console.warn(`[ai] cerebras: ${cerebras.warning}`);

  const mistral = await callWithCircuit("mistral", () => callMistral(messages));
  if (!mistral.offline) return { content: mistral.content, provider: "mistral", warning: "Used Mistral fallback" };
  if (mistral.warning) console.warn(`[ai] mistral: ${mistral.warning}`);

  const or = await callWithCircuit("openrouter", () => callOpenRouter(messages));
  if (!or.offline) return { content: or.content, provider: "openrouter", warning: "Used OpenRouter fallback" };
  if (or.warning) console.warn(`[ai] openrouter: ${or.warning}`);

  throw new Error("All LLM providers are unavailable. Check your API keys.");
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
