import assert from "node:assert/strict";
import { test } from "node:test";
import { MicroCache, KeyedMicroCache } from "../src/cache.js";
import { isTransientDbError, withDbRetry } from "../src/db.js";

test("MicroCache coalesces concurrent in-flight requests into one single execution", async () => {
  const cache = new MicroCache<number>(1000);
  let executionCount = 0;

  const fetcher = async () => {
    executionCount++;
    await new Promise((r) => setTimeout(r, 50));
    return 42;
  };

  const results = await Promise.all([
    cache.getOrFetch(fetcher),
    cache.getOrFetch(fetcher),
    cache.getOrFetch(fetcher),
    cache.getOrFetch(fetcher),
  ]);

  assert.deepEqual(results, [42, 42, 42, 42]);
  assert.equal(executionCount, 1);
});

test("MicroCache serves cached data within TTL and refetches after expiry", async () => {
  const cache = new MicroCache<number>(60);
  let executionCount = 0;

  const fetcher = async () => {
    executionCount++;
    return executionCount * 10;
  };

  const val1 = await cache.getOrFetch(fetcher);
  assert.equal(val1, 10);
  assert.equal(executionCount, 1);

  // Still within TTL
  const val2 = await cache.getOrFetch(fetcher);
  assert.equal(val2, 10);
  assert.equal(executionCount, 1);

  // Wait for TTL to expire
  await new Promise((r) => setTimeout(r, 70));
  const val3 = await cache.getOrFetch(fetcher);
  assert.equal(val3, 20);
  assert.equal(executionCount, 2);
});

test("KeyedMicroCache coalesces requests per key independently", async () => {
  const cache = new KeyedMicroCache<string>(1000, 10);
  let execA = 0;
  let execB = 0;

  const results = await Promise.all([
    cache.getOrFetch("keyA", async () => { execA++; await new Promise((r) => setTimeout(r, 20)); return "A"; }),
    cache.getOrFetch("keyA", async () => { execA++; return "A"; }),
    cache.getOrFetch("keyB", async () => { execB++; await new Promise((r) => setTimeout(r, 20)); return "B"; }),
    cache.getOrFetch("keyB", async () => { execB++; return "B"; }),
  ]);

  assert.deepEqual(results, ["A", "A", "B", "B"]);
  assert.equal(execA, 1);
  assert.equal(execB, 1);
});

test("isTransientDbError accurately detects transient database errors", () => {
  assert.equal(isTransientDbError(new Error("SQLITE_BUSY: database is locked")), true);
  assert.equal(isTransientDbError({ code: "SQLITE_BUSY" }), true);
  assert.equal(isTransientDbError(new Error("fetch failed")), true);
  assert.equal(isTransientDbError(new Error("Server returned status 503")), true);
  assert.equal(isTransientDbError(new Error("Request timed out")), true);

  // Non-transient errors should NOT be retried
  assert.equal(isTransientDbError(new Error("no such table: jm_unknown")), false);
  assert.equal(isTransientDbError(new Error("CHECK constraint failed")), false);
  assert.equal(isTransientDbError(new Error("syntax error in SQL statement")), false);
  assert.equal(isTransientDbError(null), false);
});

test("withDbRetry retries transient errors and succeeds when resolved", async () => {
  let attempts = 0;
  const result = await withDbRetry(async () => {
    attempts++;
    if (attempts < 3) {
      const err: any = new Error("SQLITE_BUSY: database is locked");
      err.code = "SQLITE_BUSY";
      throw err;
    }
    return "success";
  }, 3);

  assert.equal(result, "success");
  assert.equal(attempts, 3);
});

test("withDbRetry throws immediately on non-transient errors without wasteful retries", async () => {
  let attempts = 0;
  await assert.rejects(
    async () => {
      await withDbRetry(async () => {
        attempts++;
        throw new Error("syntax error near WHERE");
      }, 3);
    },
    /syntax error/
  );

  assert.equal(attempts, 1);
});
