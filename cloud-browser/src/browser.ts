import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { config } from "./config.js";
import { policyFor, redact, type PlatformId } from "./policy.js";
import { assertNavigableUrl } from "./url-guard.js";
import type { Account } from "./store.js";

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-blink-features=AutomationControlled",
];

let browserPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: config.headless, args: LAUNCH_ARGS }).then((browser) => {
      browser.on("disconnected", () => {
        browserPromise = null;
      });
      return browser;
    });
  }
  try {
    return await browserPromise;
  } catch (error) {
    browserPromise = null;
    throw error;
  }
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  await browser?.close().catch(() => undefined);
}

async function guardRoute(route: Route, allowedHosts: string[]): Promise<void> {
  const request = route.request();
  if (request.resourceType() !== "document") {
    await route.continue().catch(() => undefined);
    return;
  }
  try {
    await assertNavigableUrl(request.url(), allowedHosts);
    await route.continue();
  } catch {
    await route.abort("blockedbyclient").catch(() => undefined);
  }
}

export type OpenContextOptions = {
  account: Account;
  allowedHosts: string[];
  storageState?: Record<string, unknown> | null;
};

/**
 * WhatsApp Web (and some other portals) refuse the default "HeadlessChrome"
 * user agent with an "update your browser" page. We present the real browser
 * version as a normal desktop Chrome build so the site renders its UI.
 */
async function desktopUserAgent(browser: Browser): Promise<string> {
  const version = browser.version();
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

export async function openContext(options: OpenContextOptions): Promise<{ context: BrowserContext; page: Page }> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: config.viewport,
    userAgent: await desktopUserAgent(browser),
    locale: "en-US",
    timezoneId: "UTC",
    acceptDownloads: false,
    serviceWorkers: "block",
    storageState: (options.storageState as never) ?? undefined,
  });
  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(30_000);
  await context.route("**/*", (route) => guardRoute(route, options.allowedHosts));
  const page = await context.newPage();
  return { context, page };
}

export async function exportState(context: BrowserContext): Promise<Record<string, unknown>> {
  return (await context.storageState()) as unknown as Record<string, unknown>;
}

export async function goto(page: Page, url: string, allowedHosts: string[]): Promise<void> {
  const target = await assertNavigableUrl(url, allowedHosts);
  await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
}

export type SessionVerdict = {
  status: "verified" | "expired" | "unverified";
  url: string;
  detail: string;
};

/**
 * Proves whether the stored session really reaches the signed-in experience.
 * A profile existing is never treated as proof of a working login.
 */
export async function verifySession(account: Account, storageState: Record<string, unknown> | null): Promise<SessionVerdict> {
  const policy = policyFor(account.platform);
  const checkUrl = account.platform === "custom" ? account.startUrl : policy.sessionCheck.url;
  const allowedHosts = [...policyHosts(account)];
  const { context, page } = await openContext({ account, allowedHosts, storageState });
  try {
    await goto(page, checkUrl || account.startUrl, allowedHosts);
    // Give single-page apps a moment to render either the signed-in shell or the
    // login/QR screen before judging the session.
    const selector = policy.sessionCheck.loggedInSelector;
    if (selector) {
      await page.waitForSelector(selector, { timeout: 12_000 }).catch(() => undefined);
    }
    const finalUrl = page.url();
    const body = await page.evaluate(() => (document.body?.innerText ?? "").toLowerCase().slice(0, 6000));
    const expiredPattern = policy.sessionCheck.expiredUrlPattern ?? "/(login|signin|auth)";
    if (new RegExp(expiredPattern, "i").test(finalUrl)) {
      return { status: "expired", url: finalUrl, detail: "redirected_to_login" };
    }
    // A visible password field means the site is asking to sign in, whatever the
    // URL says (Facebook serves its login form at the root).
    const passwordField = await page.$("input[type='password']");
    if (passwordField && (await passwordField.isVisible().catch(() => false))) {
      return { status: "expired", url: finalUrl, detail: "password_form_present" };
    }
    const loggedOutText = policy.sessionCheck.loggedOutText ?? [];
    if (loggedOutText.some((text) => body.includes(text.toLowerCase()))) {
      return { status: "expired", url: finalUrl, detail: "logged_out_marker_visible" };
    }
    if (selector && (await page.$(selector))) {
      return { status: "verified", url: finalUrl, detail: "logged_in_selector_present" };
    }
    if (account.platform === "custom" && /(inbox|dashboard|home)/i.test(finalUrl) && !(await page.$("input[type='password']"))) {
      return { status: "verified", url: finalUrl, detail: "authenticated_page_reached" };
    }
    return { status: "unverified", url: redact(finalUrl, 400), detail: "no_conclusive_marker" };
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function policyHosts(account: Pick<Account, "platform" | "startUrl" | "loginUrl" | "inboxUrl">): string[] {
  const policy = policyFor(account.platform as PlatformId);
  const hosts = [...policy.hosts];
  for (const raw of [account.startUrl, account.loginUrl, account.inboxUrl, policy.sessionCheck.url]) {
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (host && !hosts.includes(host)) hosts.push(host);
    } catch {
      // ignore malformed
    }
  }
  return hosts;
}
