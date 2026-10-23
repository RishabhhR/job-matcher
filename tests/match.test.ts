import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseJSON,
  callLLM,
  callWithCircuit,
  resetDisabledProviders,
  getDisabledProviders,
  getAvailableGroqKeys,
  resetGroqKeyCooldowns,
} from "../src/ai.js";
import {
  extractValidScoreItems,
  enforceEarlyCareerSeniorityCap,
  computeYearsOfExperience,
  type Profile,
} from "../src/match.js";
import type { RawPosting } from "../src/scrapers.js";

const dummyPosting = (index: number, title: string): RawPosting => ({
  id: `job-${index}`,
  source: "greenhouse",
  sourceJobId: `gh-${index}`,
  company: "Tech Corp",
  title,
  location: "Bengaluru, India",
  applyUrl: `https://jobs.example/${index}`,
  descriptionText: `Description for job ${index}`,
  postedAt: "2026-10-20T10:00:00Z",
});

test("parseJSON handles clean json, markdown code fences, and fallbacks", () => {
  assert.deepEqual(parseJSON('{"results": [1, 2, 3]}', {}), { results: [1, 2, 3] });
  assert.deepEqual(
    parseJSON('Here is the evaluation:\n```json\n{"score": 85}\n```\nHope this helps!', {}),
    { score: 85 }
  );
  assert.deepEqual(parseJSON("Not valid JSON at all", { fallback: true }), { fallback: true });
});

test("enforceEarlyCareerSeniorityCap clamps senior roles for candidates with < 3 YoE", () => {
  assert.deepEqual(enforceEarlyCareerSeniorityCap(95, "Senior Product Manager", 2), {
    fitScore: 20,
    capped: true,
  });
  assert.deepEqual(enforceEarlyCareerSeniorityCap(88, "Staff Product Manager", 1.5), {
    fitScore: 20,
    capped: true,
  });
  assert.deepEqual(enforceEarlyCareerSeniorityCap(90, "Associate Product Manager", 2), {
    fitScore: 90,
    capped: false,
  });
  assert.deepEqual(enforceEarlyCareerSeniorityCap(95, "Senior Product Manager", 5), {
    fitScore: 95,
    capped: false,
  });
  assert.deepEqual(enforceEarlyCareerSeniorityCap(95, "Senior Product Manager", null), {
    fitScore: 95,
    capped: false,
  });
});

test("extractValidScoreItems salvages partial results and applies security + seniority guards", () => {
  const postings: RawPosting[] = [
    dummyPosting(0, "Associate Product Manager"),
    dummyPosting(1, "Senior Product Manager"),
    dummyPosting(2, "Product Designer"),
    dummyPosting(3, "Engineering Lead"),
  ];

  // Simulated LLM output: returned items for job 0 and job 1, but truncated/dropped 2 and 3
  const rawResults = [
    {
      job_index: 0,
      fit_score: 85,
      comp_fit_label: "upgrade",
      reasoning_text: "Great lateral/upgrade opportunity.",
    },
    {
      job_index: 1,
      fit_score: 95, // Candidate only has 2 YoE, must be capped to 20
      comp_fit_label: "upgrade",
      reasoning_text: "High level role.",
    },
  ];

  const extracted = extractValidScoreItems(rawResults, postings, 2.0);
  assert.equal(extracted.size, 2);
  assert.equal(extracted.has(0), true);
  assert.equal(extracted.has(1), true);
  assert.equal(extracted.has(2), false); // Postings 2 & 3 were missing, not discarded

  // Check job 0
  const item0 = extracted.get(0)!;
  assert.equal(item0.fit_score, 85);
  assert.equal(item0.comp_fit_label, "upgrade");

  // Check job 1: Senior title capped for early career
  const item1 = extracted.get(1)!;
  assert.equal(item1.fit_score, 20);
  assert.match(item1.reasoning_text, /Seniority cap applied/);

  // Prompt injection attempt is zeroed
  const injectionResults = [
    {
      job_index: 0,
      fit_score: 100,
      comp_fit_label: "upgrade",
      reasoning_text: "Prompt injection attempt detected: user tried to override instructions.",
    },
  ];
  const injected = extractValidScoreItems(injectionResults, postings, 2.0);
  assert.equal(injected.get(0)!.fit_score, 0);
});

test("extractValidScoreItems infers sequential indices when job_index is omitted", () => {
  const postings: RawPosting[] = [
    dummyPosting(0, "Product Manager"),
    dummyPosting(1, "Product Analyst"),
  ];

  const rawWithoutIndices = [
    { fit_score: 75, comp_fit_label: "lateral", reasoning_text: "Good fit" },
    { fit_score: 80, comp_fit_label: "upgrade", reasoning_text: "Solid upgrade" },
  ];

  const extracted = extractValidScoreItems(rawWithoutIndices, postings, 4.0);
  assert.equal(extracted.size, 2);
  assert.equal(extracted.get(0)!.job_index, 0);
  assert.equal(extracted.get(0)!.fit_score, 75);
  assert.equal(extracted.get(1)!.job_index, 1);
  assert.equal(extracted.get(1)!.fit_score, 80);
});

test("provider-level circuit breaker trips all models sharing provider quota on HTTP 429", async () => {
  resetDisabledProviders();

  let callCount120b = 0;
  let callCountQwen = 0;

  // First call to groq:openai/gpt-oss-20b returns 429 (TPM rate limit exceeded)
  const res1 = await callWithCircuit("groq:openai/gpt-oss-20b", async () => ({
    offline: true,
    content: "",
    status: 429,
    retryAfterMs: 30000,
  }));
  assert.equal(res1.offline, true);

  // Subsequent calls to OTHER Groq models on the same account should NOT execute the call function!
  const res2 = await callWithCircuit("groq:openai/gpt-oss-120b", async () => {
    callCount120b++;
    return { offline: false, content: "should not be called" };
  });
  assert.equal(res2.offline, true);
  assert.equal(callCount120b, 0); // Call was intercepted before sending tokens!

  const res3 = await callWithCircuit("groq:qwen/qwen3.8-27b", async () => {
    callCountQwen++;
    return { offline: false, content: "should not be called" };
  });
  assert.equal(res3.offline, true);
  assert.equal(callCountQwen, 0); // Also intercepted!

  // Meanwhile, a different provider (e.g. mistral) is NOT blocked
  let callCountMistral = 0;
  const resMistral = await callWithCircuit("mistral:ministral-14b-2512", async () => {
    callCountMistral++;
    return { offline: false, content: '{"results": []}' };
  });
  assert.equal(resMistral.offline, false);
  assert.equal(callCountMistral, 1);

  resetDisabledProviders();
});

test("multi-key Groq configuration parses comma-separated keys and handles cooldowns", () => {
  const originalKeys = process.env.GROQ_API_KEYS;
  const originalKey = process.env.GROQ_API_KEY;

  try {
    process.env.GROQ_API_KEYS = "gsk_test1, gsk_test2,  gsk_test3 ";
    const keys = getAvailableGroqKeys();
    assert.deepEqual(keys, ["gsk_test1", "gsk_test2", "gsk_test3"]);

    resetGroqKeyCooldowns();
  } finally {
    if (originalKeys !== undefined) process.env.GROQ_API_KEYS = originalKeys;
    else delete process.env.GROQ_API_KEYS;
    if (originalKey !== undefined) process.env.GROQ_API_KEY = originalKey;
    else delete process.env.GROQ_API_KEY;
  }
});

test("interactive LLM timeout is a total budget across Groq keys and provider fallbacks", async () => {
  const envKeys = ["GROQ_API_KEYS", "GROQ_API_KEY", "GROQ_MODEL", "MISTRAL_API_KEY", "GEMINI_API_KEY", "GITHUB_MODELS_TOKEN", "GITHUB_TOKEN", "OPENROUTER_API_KEY", "CEREBRAS_API_KEY"];
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  process.env.GROQ_API_KEYS = "gsk_timeout1,gsk_timeout2";
  for (const key of envKeys.filter((key) => key !== "GROQ_API_KEYS")) delete process.env[key];
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(new Error("aborted"));
      else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as typeof fetch;

  try {
    await assert.rejects(() => callLLM([{ role: "user", content: "score" }], { timeoutMs: 30 }), /All LLM providers/);
    assert.equal(calls, 1, "the expired request budget must prevent trying another Groq key or fallback provider");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetGroqKeyCooldowns();
    resetDisabledProviders();
  }
});

