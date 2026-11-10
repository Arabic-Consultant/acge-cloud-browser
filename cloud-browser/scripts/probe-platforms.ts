/**
 * Live platform probe (no accounts, no credentials).
 *
 * Opens each platform's protected page with an empty browser session and asserts
 * that the runtime reports `expired` — i.e. the logged-out detection really
 * works against the live sites. This validates host allowlists, navigation and
 * session checks without touching any real account.
 *
 *   pnpm --dir cloud-browser probe
 */
import { verifySession, closeBrowser } from "../src/browser.js";
import { PLATFORMS, type PlatformId } from "../src/policy.js";
import type { Account } from "../src/store.js";

const platforms: Array<Exclude<PlatformId, "custom">> = ["facebook", "instagram", "whatsapp", "linkedin"];

async function main() {
  let failures = 0;
  for (const platform of platforms) {
    const policy = PLATFORMS[platform];
    const account: Account = {
      id: `probe_${platform}`,
      platform,
      label: `probe ${platform}`,
      startUrl: policy.startUrl,
      loginUrl: policy.loginUrl,
      inboxUrl: policy.inboxUrl,
      status: "unverified",
      hasStoredSession: false,
      lastVerifiedAt: null,
      lastUsedAt: null,
      lastError: null,
      lastUrl: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const started = Date.now();
    try {
      const verdict = await verifySession(account, null);
      const ok = verdict.status === "expired";
      if (!ok) failures += 1;
      console.log(
        JSON.stringify({
          platform,
          expected: "expired",
          got: verdict.status,
          detail: verdict.detail,
          url: verdict.url,
          ms: Date.now() - started,
          ok,
        }),
      );
    } catch (error) {
      failures += 1;
      console.log(JSON.stringify({ platform, error: error instanceof Error ? error.message : "probe_failed", ok: false }));
    }
  }
  await closeBrowser();
  if (failures > 0) {
    console.error(`\n${failures} platform probe(s) did not detect the logged-out state.`);
    process.exitCode = 1;
  }
}

void main();
