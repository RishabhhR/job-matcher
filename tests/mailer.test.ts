import assert from "node:assert/strict";
import { test } from "node:test";
import { mailProvider } from "../src/mailer.js";

test("Gmail is used only when both GMAIL_USER and GMAIL_APP_PASSWORD are set (TASK-071)", () => {
  assert.equal(mailProvider({ GMAIL_USER: "me@example.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" }), "gmail");
  assert.equal(mailProvider({ GMAIL_USER: "me@example.com" }), "resend");
  assert.equal(mailProvider({ GMAIL_APP_PASSWORD: "abcdefghijklmnop" }), "resend");
  assert.equal(mailProvider({ GMAIL_USER: "  ", GMAIL_APP_PASSWORD: "abcdefghijklmnop" }), "resend");
  assert.equal(mailProvider({}), "resend");
});
