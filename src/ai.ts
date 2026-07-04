const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type Message = { role: "system" | "user" | "assistant"; content: string };

interface LLMResult {
  offline: boolean;
  content: string;
  warning?: string;
}

async function callGroq(messages: Message[], timeoutMs = 60000): Promise<LLMResult> {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  if (!apiKey) return { offline: true, content: "" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(GROQ_URL, {
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
      return { offline: true, content: "", warning: `Groq HTTP ${res.status}: ${body.slice(0, 300)}` };
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
    if (!res.ok) return { offline: true, content: "", warning: `Gemini HTTP ${res.status}` };
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
        model: "mistralai/mistral-7b-instruct",
        messages,
        temperature: 0.2,
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return { offline: true, content: "", warning: `OpenRouter HTTP ${res.status}` };
    const data = await res.json();
    return { offline: false, content: data.choices[0].message.content };
  } catch {
    clearTimeout(timer);
    return { offline: true, content: "", warning: "OpenRouter request failed or timed out" };
  }
}

export async function callLLM(messages: Message[]): Promise<{ content: string; provider: string; warning?: string }> {
  const groq = await callGroq(messages);
  if (!groq.offline) return { content: groq.content, provider: "groq" };
  if (groq.warning) console.warn(`[ai] groq: ${groq.warning}`);

  const systemPrompt = messages.find((m) => m.role === "system")?.content || "";
  const userPrompt = messages.find((m) => m.role === "user")?.content || "";
  const gemini = await callGemini(systemPrompt, userPrompt);
  if (!gemini.offline) return { content: gemini.content, provider: "gemini", warning: "Used Gemini fallback" };
  if (gemini.warning) console.warn(`[ai] gemini: ${gemini.warning}`);

  const or = await callOpenRouter(messages);
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
