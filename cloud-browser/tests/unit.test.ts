import assert from "node:assert/strict";
import test from "node:test";
import { actionExecutionBlocked, redact } from "../src/policy.js";
import { extractFindings } from "../src/planner.js";
import { assertNavigableUrl, hostAllowed, UrlBlockedError } from "../src/url-guard.js";
import { countOccurrences } from "../src/agent.js";

test("redact strips cookies, bearer tokens and blobs", () => {
  const input = "Cookie: sid=ok; sessionid=abc123456; header Authorization: Bearer abcdef1234567890 token=deadbeef123456";
  const output = redact(input);
  assert.doesNotMatch(output, /sid=ok/);
  assert.doesNotMatch(output, /Bearer abcdef/);
  assert.match(output, /redacted/);
});

test("extractFindings dedupes and caps noisy lines", () => {
  const text = ["قصير", "عنوان محادثة أولى مع عميل يحتاج رداً عاجلاً", "عنوان محادثة أولى مع عميل يحتاج رداً عاجلاً", "عنوان ثانٍ لاستفسار عن برنامج التحول الرقمي"].join("\n");
  const findings = extractFindings(text);
  assert.equal(findings.length, 2);
  assert.match(findings[0].title, /عنوان محادثة أولى/);
});

test("host allowlist is suffix-safe", () => {
  assert.equal(hostAllowed("www.facebook.com", ["facebook.com"]), true);
  assert.equal(hostAllowed("facebook.com.evil.tld", ["facebook.com"]), false);
  assert.equal(hostAllowed("notfacebook.com", ["facebook.com"]), false);
});

test("linkedin automation stays blocked unless explicitly enabled", () => {
  assert.equal(actionExecutionBlocked("linkedin", false), "linkedin_automation_prohibited");
  assert.equal(actionExecutionBlocked("linkedin", true), null);
  assert.equal(actionExecutionBlocked("facebook", false), null);
});

test("navigation guard refuses non-allowlisted hosts and private addresses", async () => {
  await assert.rejects(() => assertNavigableUrl("https://evil.example.com/", ["facebook.com"]), UrlBlockedError);
  await assert.rejects(() => assertNavigableUrl("http://127.0.0.1:8080/", ["127.0.0.1"]), UrlBlockedError);
  await assert.rejects(() => assertNavigableUrl("file:///etc/passwd", ["facebook.com"]), UrlBlockedError);
  await assert.rejects(() => assertNavigableUrl("https://user:pass@facebook.com/", ["facebook.com"]), UrlBlockedError);
});

test("occurrence counting is exact", () => {
  assert.equal(countOccurrences("a-b-a-b-a", "a"), 3);
  assert.equal(countOccurrences("aaaa", "aa"), 2);
  assert.equal(countOccurrences("text", ""), 0);
});
