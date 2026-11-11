import type { Locator, Page } from "playwright";
import type { PlatformPolicy } from "./policy.js";

export type PageElement = {
  ref: string;
  tag: string;
  type?: string;
  label: string;
  href?: string;
  disabled?: boolean;
};

export type PageSnapshot = {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  capturedAt: string;
};

const MAX_TEXT = 12_000;
const MAX_ELEMENTS = 120;

/**
 * Stamps stable refs on interactive elements so the agent can act on them.
 * The collector is sent as a string on purpose: TypeScript transpilers inject
 * a helper (`__name`) into named inner functions, which is undefined inside the
 * page context and would break the evaluation.
 */
const SNAPSHOT_SCRIPT = String.raw`(() => {
  const maxText = ${MAX_TEXT};
  const maxElements = ${MAX_ELEMENTS};
  const visible = function (element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };
  const labelOf = function (element) {
    const aria = element.getAttribute("aria-label");
    const placeholder = element.getAttribute("placeholder");
    const title = element.getAttribute("title");
    const value = element instanceof HTMLInputElement && element.type !== "password" ? element.value : "";
    const text = ((element.innerText || element.textContent || "") + "").replace(/\s+/g, " ").trim();
    return (aria || placeholder || title || text || value || "").slice(0, 140);
  };
  const selector = "a, button, input, textarea, select, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [contenteditable='true']";
  const all = Array.from(document.querySelectorAll(selector));
  const elements = [];
  let index = 0;
  for (const element of all) {
    if (index >= maxElements) break;
    if (!visible(element)) continue;
    const label = labelOf(element);
    const isPassword = element instanceof HTMLInputElement && element.type === "password";
    if (!label && !isPassword) continue;
    index += 1;
    const ref = "e" + index;
    element.setAttribute("data-acge-ref", ref);
    const href = element instanceof HTMLAnchorElement ? element.getAttribute("href") : null;
    elements.push({
      ref: ref,
      tag: element.tagName.toLowerCase(),
      type: element instanceof HTMLInputElement ? element.type : undefined,
      label: isPassword ? "[password field]" : label,
      href: href ? href.slice(0, 200) : undefined,
      disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true"
    });
  }
  return {
    url: window.location.href,
    title: document.title.slice(0, 200),
    text: (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").slice(0, maxText),
    elements: elements
  };
})()`;

export async function snapshot(page: Page): Promise<PageSnapshot> {
  const data = (await page.evaluate(SNAPSHOT_SCRIPT)) as Omit<PageSnapshot, "capturedAt">;
  return { ...data, capturedAt: new Date().toISOString() };
}

export function refLocator(page: Page, ref: string): Locator {
  if (!/^e\d{1,3}$/.test(ref)) throw new Error("invalid_element_ref");
  return page.locator(`[data-acge-ref="${ref}"]`).first();
}

export async function clickRef(page: Page, ref: string): Promise<void> {
  const locator = refLocator(page, ref);
  await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  await locator.click({ timeout: 8_000 });
}

export async function typeIntoRef(page: Page, ref: string, value: string, submit: boolean): Promise<void> {
  const locator = refLocator(page, ref);
  await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  const editable = await locator.evaluate((element) => ({
    contentEditable: (element as HTMLElement).isContentEditable,
    tag: element.tagName.toLowerCase(),
  }));
  await locator.click({ timeout: 8_000 });
  if (editable.contentEditable) {
    await page.keyboard.insertText(value);
  } else if (editable.tag === "input" || editable.tag === "textarea") {
    await locator.fill(value, { timeout: 8_000 });
  } else {
    await page.keyboard.insertText(value);
  }
  if (submit) await page.keyboard.press("Enter");
}

export async function readText(page: Page, limit = 12_000): Promise<string> {
  return (await page.evaluate(() => (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n"), [])).slice(0, limit);
}

export async function screenshot(page: Page, quality = 62): Promise<string> {
  const buffer = await page.screenshot({
    type: "jpeg",
    quality,
    fullPage: false,
    // Render at CSS pixel scale and skip animations; lower quality + smaller
    // frames are the main levers for live-view latency.
    scale: "css",
    animations: "disabled",
    timeout: 10_000,
  });
  return buffer.toString("base64");
}

/** Finds the final "send" control but never clicks it without explicit approval. */
export async function findSendControl(page: Page, policy: PlatformPolicy): Promise<{ ref: string; label: string } | null> {
  const pattern = new RegExp(policy.sendControlPattern, "i");
  const candidates = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("button, [role='button'], div[contenteditable='true'] + div button, [aria-label]"));
    return nodes
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 8 && rect.height > 8;
      })
      .map((element) => ({
        ref: element.getAttribute("data-acge-ref") ?? "",
        label: (element.getAttribute("aria-label") || (element as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
        disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
      }))
      .filter((item) => item.label);
  });
  for (const item of candidates) {
    if (!item.disabled && pattern.test(item.label)) {
      if (item.ref) return { ref: item.ref, label: item.label };
      const element = page.getByRole("button", { name: new RegExp(`^${escapeRegExp(item.label)}$`) }).first();
      if (await element.count()) {
        await element.evaluate((node) => node.setAttribute("data-acge-ref", "esend")).catch(() => undefined);
        return { ref: "esend", label: item.label };
      }
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/** Reads the current composer value/text, or null when no composer is present. */
export async function composerContent(page: Page, selectors: string[]): Promise<string | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    if (!(await locator.count().catch(() => 0))) continue;
    const value = await locator
      .evaluate((element) => {
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
        return (element as HTMLElement).innerText || element.textContent || "";
      })
      .catch(() => "");
    return value;
  }
  return null;
}

export async function dismissSafeDialogs(page: Page): Promise<void> {
  page.on("dialog", (dialog) => {
    void dialog.dismiss().catch(() => undefined);
  });
}
