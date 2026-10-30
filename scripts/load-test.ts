/**
 * Load Testing Suite for JobMatcher Infrastructure
 * Evaluates Vercel Serverless Function & Turso Database limits without consuming LLM tokens.
 */

import { performance } from "node:perf_hooks";

const BASE_URL = process.env.TARGET_URL || "http://localhost:3000";
if (BASE_URL.includes("vercel.app") && process.env.CONFIRM_PROD_LOAD_TEST !== "1") {
  console.error("Refusing to run load test against production without CONFIRM_PROD_LOAD_TEST=1.");
  process.exit(1);
}

interface RequestResult {
  durationMs: number;
  statusCode: number;
  ok: boolean;
  error?: string;
  cacheStatus?: string;
}

interface BenchmarkSummary {
  name: string;
  totalRequests: number;
  concurrency: number;
  totalDurationMs: number;
  rps: number;
  successRate: number;
  statusCodes: Record<number, number>;
  cacheHits: number;
  cacheMisses: number;
  errors: number;
  latencies: {
    min: number;
    mean: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
  };
}

function calculatePercentiles(latencies: number[]): {
  min: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
} {
  if (latencies.length === 0) {
    return { min: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = Math.round(sum / sorted.length);

  const getP = (p: number) => {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Math.round(sorted[idx]);
  };

  return {
    min: Math.round(sorted[0]),
    mean,
    p50: getP(50),
    p90: getP(90),
    p95: getP(95),
    p99: getP(99),
    max: Math.round(sorted[sorted.length - 1]),
  };
}

async function runWorker(
  tasks: Array<() => Promise<RequestResult>>,
  results: RequestResult[],
  counter: { index: number }
): Promise<void> {
  while (counter.index < tasks.length) {
    const idx = counter.index++;
    const res = await tasks[idx]();
    results.push(res);
  }
}

async function benchmark(
  name: string,
  requestFns: Array<() => Promise<RequestResult>>,
  concurrency: number
): Promise<BenchmarkSummary> {
  process.stdout.write(`\n🚀 Starting Benchmark: [${name}] (${requestFns.length} requests, concurrency: ${concurrency})...\n`);
  const results: RequestResult[] = [];
  const counter = { index: 0 };
  const startTime = performance.now();

  const workers = Array.from({ length: concurrency }, () => runWorker(requestFns, results, counter));
  await Promise.all(workers);

  const totalDurationMs = performance.now() - startTime;
  const statusCodes: Record<number, number> = {};
  let cacheHits = 0;
  let cacheMisses = 0;
  let errors = 0;
  const latencies: number[] = [];

  for (const r of results) {
    statusCodes[r.statusCode] = (statusCodes[r.statusCode] || 0) + 1;
    if (r.cacheStatus === "HIT") cacheHits++;
    if (r.cacheStatus === "MISS") cacheMisses++;
    if (!r.ok) errors++;
    latencies.push(r.durationMs);
  }

  const rps = Math.round((results.length / (totalDurationMs / 1000)) * 10) / 10;
  const successRate = Math.round(((results.length - errors) / results.length) * 1000) / 10;

  return {
    name,
    totalRequests: results.length,
    concurrency,
    totalDurationMs: Math.round(totalDurationMs),
    rps,
    successRate,
    statusCodes,
    cacheHits,
    cacheMisses,
    errors,
    latencies: calculatePercentiles(latencies),
  };
}

function printSummary(s: BenchmarkSummary): void {
  console.log(`\n========================================================`);
  console.log(`  BENCHMARK: ${s.name}`);
  console.log(`========================================================`);
  console.log(`  Requests:       ${s.totalRequests} across ${s.concurrency} concurrent clients`);
  console.log(`  Duration:       ${(s.totalDurationMs / 1000).toFixed(2)}s`);
  console.log(`  Throughput:     ${s.rps} req/sec`);
  console.log(`  Success Rate:   ${s.successRate}% (${s.errors} errors)`);
  console.log(`  Status Codes:   ${JSON.stringify(s.statusCodes)}`);
  if (s.cacheHits > 0 || s.cacheMisses > 0) {
    console.log(`  Vercel Cache:   ${s.cacheHits} HITs, ${s.cacheMisses} MISSes`);
  }
  console.log(`  Latency Distribution:`);
  console.log(`    Min:          ${s.latencies.min}ms`);
  console.log(`    Mean:         ${s.latencies.mean}ms`);
  console.log(`    p50 (Median): ${s.latencies.p50}ms`);
  console.log(`    p90:          ${s.latencies.p90}ms`);
  console.log(`    p95:          ${s.latencies.p95}ms`);
  console.log(`    p99:          ${s.latencies.p99}ms`);
  console.log(`    Max:          ${s.latencies.max}ms`);
  console.log(`========================================================\n`);
}

// Request generators:
async function makeGet(path: string): Promise<RequestResult> {
  const url = `${BASE_URL}${path}`;
  const start = performance.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "JobMatcher-LoadTest/1.0" },
    });
    const durationMs = performance.now() - start;
    const cacheStatus = res.headers.get("x-vercel-cache") || undefined;
    await res.text(); // drain
    return {
      durationMs,
      statusCode: res.status,
      ok: res.ok,
      cacheStatus,
    };
  } catch (err: any) {
    return {
      durationMs: performance.now() - start,
      statusCode: 0,
      ok: false,
      error: err.message,
    };
  }
}

async function makePost(path: string, body: any): Promise<RequestResult> {
  const url = `${BASE_URL}${path}`;
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "JobMatcher-LoadTest/1.0",
      },
      body: JSON.stringify(body),
    });
    const durationMs = performance.now() - start;
    const cacheStatus = res.headers.get("x-vercel-cache") || undefined;
    await res.text();
    return {
      durationMs,
      statusCode: res.status,
      ok: res.ok,
      cacheStatus,
    };
  } catch (err: any) {
    return {
      durationMs: performance.now() - start,
      statusCode: 0,
      ok: false,
      error: err.message,
    };
  }
}

async function main() {
  console.log(`🎯 Target Target URL: ${BASE_URL}`);
  console.log(`🔒 LLM tokens: STRICTLY 0 (Testing only Vercel CDN, Serverless compute & Turso DB)\n`);

  // Probe a sample job ID
  let sampleJobId = "641e8429-4c95-48d6-8e4a-55dbddc0a5a0";
  try {
    const html = await (await fetch(`${BASE_URL}/jobs`)).text();
    const match = html.match(/\/jobs\/([a-zA-Z0-9_-]{36})/);
    if (match) sampleJobId = match[1];
  } catch {
    // fallback
  }

  // TEST 1: Edge CDN Read Performance (Static & Cached routes)
  // Concurrency: 15, Total: 100 requests
  const test1Tasks = Array.from({ length: 100 }, (_, i) => () =>
    makeGet(i % 2 === 0 ? "/" : "/jobs")
  );
  const s1 = await benchmark("Edge CDN Read Performance", test1Tasks, 15);
  printSummary(s1);

  // TEST 2: Turso DB Reads (100% Cache-Busting Dynamic Lookups)
  // Queries Turso live: jm_app_status, jm_email_send_log, and jm_job_postings
  // Concurrency: 20, Total: 100 requests
  const test2Tasks = Array.from({ length: 100 }, (_, i) => () => {
    const rand = Math.random().toString(36).slice(2, 8);
    if (i % 3 === 0) return makeGet(`/api/health/cron?rand=${rand}`);
    if (i % 3 === 1) return makeGet(`/jobs/${sampleJobId}?rand=${rand}`);
    return makeGet(`/jobs?rand=${rand}`);
  });
  const s2 = await benchmark("Turso DB Dynamic Reads (100% DB Hits)", test2Tasks, 20);
  printSummary(s2);

  // TEST 3: Turso DB Concurrent Writes
  // Concurrency: 20, Total: 100 requests to POST /api/analytics/visit (exercises DB row inserts & conflicts)
  const test3Tasks = Array.from({ length: 100 }, (_, i) => () =>
    makePost("/api/analytics/visit", {
      path: i % 2 === 0 ? "/jobs" : "/",
      referrer: "https://loadtest.jobmatcher.internal",
    })
  );
  const s3 = await benchmark("Turso DB Concurrent Writes (Analytics Upserts)", test3Tasks, 20);
  printSummary(s3);

  // TEST 4: High-Concurrency Realistic Spike (Edge + Turso Reads + Turso Writes)
  // Concurrency: 35 concurrent users, Total: 250 requests
  const test4Tasks = Array.from({ length: 250 }, (_, i) => () => {
    const rand = Math.random().toString(36).slice(2, 8);
    const mod = i % 10;
    if (mod < 4) {
      // 40% Edge cached reads
      return makeGet(i % 2 === 0 ? "/" : "/jobs");
    } else if (mod < 8) {
      // 40% Live Turso dynamic reads
      return makeGet(i % 2 === 0 ? `/api/health/cron?rand=${rand}` : `/jobs/${sampleJobId}?rand=${rand}`);
    } else {
      // 20% Live Turso writes
      return makePost("/api/analytics/visit", {
        path: `/jobs/${sampleJobId}`,
        referrer: "https://google.com",
      });
    }
  });
  const s4 = await benchmark("High-Concurrency Production Mixed Spike", test4Tasks, 35);
  printSummary(s4);

  // Overall Verdict
  console.log(`\n🏁 ================= FINAL VERDICT =================`);
  const allSummaries = [s1, s2, s3, s4];
  const totalReqs = allSummaries.reduce((acc, s) => acc + s.totalRequests, 0);
  const totalErrors = allSummaries.reduce((acc, s) => acc + s.errors, 0);
  const overallSuccess = (((totalReqs - totalErrors) / totalReqs) * 100).toFixed(2);

  console.log(`  Total requests executed: ${totalReqs}`);
  console.log(`  Total failed requests:   ${totalErrors}`);
  console.log(`  Overall success rate:    ${overallSuccess}%`);
  console.log(`  Edge CDN median latency: ${s1.latencies.p50}ms (p95: ${s1.latencies.p95}ms)`);
  console.log(`  Turso Read median latency: ${s2.latencies.p50}ms (p95: ${s2.latencies.p95}ms)`);
  console.log(`  Turso Write median latency: ${s3.latencies.p50}ms (p95: ${s3.latencies.p95}ms)`);
  console.log(`  Mixed Spike median latency: ${s4.latencies.p50}ms (p95: ${s4.latencies.p95}ms)`);
  console.log(`====================================================\n`);
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
