/**
 * High-Scale 5,000 User Traffic Load Test for JobMatcher
 * Evaluates Vercel Edge & Serverless + Turso limits under 5,000 requests.
 * Strictly 0 LLM tokens consumed.
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

function calculatePercentiles(latencies: number[]) {
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
  console.log(`\n🚀 Starting Benchmark: [${name}] (${requestFns.length} requests, concurrency: ${concurrency})...`);
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
  console.log(`  Requests:       ${s.totalRequests} across ${s.concurrency} concurrent workers`);
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

async function makeGet(path: string): Promise<RequestResult> {
  const url = `${BASE_URL}${path}`;
  const start = performance.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "JobMatcher-5K-LoadTest/1.0" },
    });
    const durationMs = performance.now() - start;
    const cacheStatus = res.headers.get("x-vercel-cache") || undefined;
    await res.text();
    return { durationMs, statusCode: res.status, ok: res.ok, cacheStatus };
  } catch (err: any) {
    return { durationMs: performance.now() - start, statusCode: 0, ok: false, error: err.message };
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
        "User-Agent": "JobMatcher-5K-LoadTest/1.0",
      },
      body: JSON.stringify(body),
    });
    const durationMs = performance.now() - start;
    await res.text();
    return { durationMs, statusCode: res.status, ok: res.ok };
  } catch (err: any) {
    return { durationMs: performance.now() - start, statusCode: 0, ok: false, error: err.message };
  }
}

async function main() {
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`🔒 LLM tokens: STRICTLY 0`);
  console.log(`👥 Simulating 5,000 user requests across Edge CDN, Dynamic Turso Reads, and Writes\n`);

  // Phase 1: 2,000 requests to Edge CDN / Cached Landing & Jobs (Concurrency: 100)
  const p1Tasks = Array.from({ length: 2000 }, (_, i) => () =>
    makeGet(i % 2 === 0 ? "/" : "/jobs")
  );
  const s1 = await benchmark("Phase 1: Edge CDN 2,000 Requests (Concurrency 100)", p1Tasks, 100);
  printSummary(s1);

  // Phase 2: 1,500 requests to Dynamic Turso Reads (Concurrency: 60)
  const p2Tasks = Array.from({ length: 1500 }, () => {
    const rand = Math.random().toString(36).slice(2, 8);
    return () => makeGet(`/api/public/jobs/summary?rand=${rand}`);
  });
  const s2 = await benchmark("Phase 2: Turso Dynamic Reads 1,500 Requests (Concurrency 60)", p2Tasks, 60);
  printSummary(s2);

  // Phase 3: 1,500 mixed requests (Edge + Turso reads + Turso writes, Concurrency: 80)
  const p3Tasks = Array.from({ length: 1500 }, (_, i) => () => {
    const mod = i % 5;
    if (mod === 0) {
      return makePost("/api/analytics/visit", {
        path: "/jobs",
        referrer: "https://google.com/search?q=jobmatcher",
      });
    } else if (mod === 1 || mod === 2) {
      const rand = Math.random().toString(36).slice(2, 8);
      return makeGet(`/api/public/jobs/summary?rand=${rand}`);
    } else {
      return makeGet(i % 2 === 0 ? "/" : "/jobs");
    }
  });
  const s3 = await benchmark("Phase 3: Mixed Real-World 1,500 Requests (Concurrency 80)", p3Tasks, 80);
  printSummary(s3);

  console.log(`\n🏁 ================= 5,000 TRAFFIC RUN VERDICT =================`);
  const all = [s1, s2, s3];
  const totalReqs = all.reduce((a, s) => a + s.totalRequests, 0);
  const totalErrors = all.reduce((a, s) => a + s.errors, 0);
  console.log(`  Total Requests Executed: ${totalReqs}`);
  console.log(`  Total Successful:        ${totalReqs - totalErrors}`);
  console.log(`  Total Failures:          ${totalErrors}`);
  console.log(`  Overall Success Rate:    ${(((totalReqs - totalErrors) / totalReqs) * 100).toFixed(2)}%`);
  console.log(`=================================================================\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
