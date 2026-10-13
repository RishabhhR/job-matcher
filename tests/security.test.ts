import assert from "node:assert/strict";
import { test } from "node:test";
import { getVerifiedPrimaryEmail } from "../src/clerkAuth.js";
import { parseCompanySources } from "../src/inputValidation.js";
import { escapeHtml, safeApplyUrl } from "../src/mailer.js";

test("company source input is bounded, deduplicated, and slug-validated", () => {
  assert.deepEqual(parseCompanySources({
    greenhouse: ["stripe", " stripe ", "Acme-1"],
    lever: [],
    ashby: ["open_ai"],
  }), {
    greenhouse: ["stripe", "Acme-1"],
    lever: [],
    ashby: ["open_ai"],
  });
  assert.equal(parseCompanySources({ greenhouse: ["https://evil.example"], lever: [], ashby: [] }), null);
  assert.equal(parseCompanySources({ greenhouse: new Array(301).fill("company"), lever: [], ashby: [] }), null);
});

test("only a verified Clerk primary email can bind a job-matcher account", () => {
  assert.equal(getVerifiedPrimaryEmail({
    primaryEmailAddress: { emailAddress: "User@Example.com", verification: { status: "verified" } },
  }), "user@example.com");
  assert.equal(getVerifiedPrimaryEmail({
    primaryEmailAddress: { emailAddress: "other@example.com", verification: { status: "unverified" } },
  }), null);
  assert.equal(getVerifiedPrimaryEmail({ primaryEmailAddress: null }), null);
});

test("email markup escapes untrusted fields and rejects unsafe apply URLs", () => {
  assert.equal(escapeHtml(`<img src=x onerror='alert(1)'>&`), "&lt;img src=x onerror=&#39;alert(1)&#39;&gt;&amp;");
  assert.equal(safeApplyUrl("javascript:alert(1)"), "#");
  assert.equal(safeApplyUrl("https://jobs.example/apply?a=1&b=2"), "https://jobs.example/apply?a=1&amp;b=2");
});
