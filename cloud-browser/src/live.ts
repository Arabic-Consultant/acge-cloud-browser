import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { config } from "./config.js";
import { exportState, goto, openContext, policyHosts } from "./browser.js";
import { clickRef, readText, screenshot, snapshot, typeIntoRef, type PageSnapshot } from "./extract.js";
import { AppLlmPlanner, PlannerUnavailableError, type AgentAction } from "./planner.js";
import { policyFor } from "./policy.js";
import { audit, accounts, type Account } from "./store.js";
import { redact } from "./policy.js";

export type LiveEvent =
  | { type: "frame"; at: string; url: string; title: string; image: string; width: number; height: number }
  | { type: "meta"; at: string; url: string; title: string }
  | { type: "input"; at: string; action: string }
  | { type: "notice"; at: string; message: string }
  | { type: "closed"; at: string; reason: string };

type Subscriber = (event: LiveEvent) => void;

export type LiveInput =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "goto"; url: string }
  | { type: "scroll"; dy: number }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" };

export class LiveSession {
  readonly id = `live_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  readonly account: Account;
  readonly createdAt = new Date().toISOString();
  lastActivity = Date.now();
  private readonly context: BrowserContext;
  private readonly page: Page;
  private readonly subscribers = new Set<Subscriber>();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  lastFrame: Extract<LiveEvent, { type: "frame" }> | null = null;
  private lastUrl = "";
  private lastAiHistory: Array<{ action: string; result: string }> = [];

  private constructor(account: Account, context: BrowserContext, page: Page) {
    this.account = account;
    this.context = context;
    this.page = page;
    page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => undefined);
      this.broadcast({ type: "notice", at: new Date().toISOString(), message: "تم إغلاق نافذة تنبيه في الموقع تلقائياً." });
    });
  }

  static async create(account: Account, storageState: Record<string, unknown> | null): Promise<LiveSession> {
    const { context, page } = await openContext({ account, allowedHosts: policyHosts(account), storageState });
    const session = new LiveSession(account, context, page);
    await goto(page, account.loginUrl || account.startUrl, policyHosts(account)).catch(async () => {
      await goto(page, account.startUrl, policyHosts(account)).catch(() => undefined);
    });
    session.startLoop();
    await audit.append({ accountId: account.id, platform: account.platform, event: "live_session_started", detail: account.loginUrl });
    return session;
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    this.lastActivity = Date.now();
    if (this.lastFrame) subscriber(this.lastFrame);
    return () => this.subscribers.delete(subscriber);
  }

  private broadcast(event: LiveEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  private startLoop(): void {
    const tick = async () => {
      if (this.closed) return;
      try {
        const [image, meta] = await Promise.all([
          screenshot(this.page, config.liveFrameQuality),
          this.page.evaluate(() => ({ url: window.location.href, title: document.title.slice(0, 160) })),
        ]);
        const frame: Extract<LiveEvent, { type: "frame" }> = {
          type: "frame",
          at: new Date().toISOString(),
          url: redact(meta.url, 400),
          title: meta.title,
          image,
          width: config.viewport.width,
          height: config.viewport.height,
        };
        this.lastFrame = frame;
        this.broadcast(frame);
        if (meta.url !== this.lastUrl) {
          this.lastUrl = meta.url;
          this.broadcast({ type: "meta", at: frame.at, url: redact(meta.url, 400), title: meta.title });
        }
      } catch {
        // Transient capture failures are expected during navigation.
      }
      if (this.subscribers.size === 0 && Date.now() - this.lastActivity > config.liveTtlMs) {
        await this.close("idle_timeout");
        return;
      }
      if (this.subscribers.size > 0) this.timer = setTimeout(tick, config.liveFrameIntervalMs);
      else this.timer = setTimeout(tick, Math.max(2000, config.liveFrameIntervalMs * 3));
    };
    this.timer = setTimeout(tick, 100);
  }

  async applyInput(input: LiveInput): Promise<{ ok: true; detail: string }> {
    if (this.closed) throw new Error("live_session_closed");
    this.lastActivity = Date.now();
    switch (input.type) {
      case "click": {
        const x = clamp01(input.x) * config.viewport.width;
        const y = clamp01(input.y) * config.viewport.height;
        await this.page.mouse.click(x, y);
        break;
      }
      case "type":
        await this.page.keyboard.insertText(input.text.slice(0, 1000));
        break;
      case "key":
        await this.page.keyboard.press(safeKey(input.key));
        break;
      case "goto":
        await goto(this.page, input.url, policyHosts(this.account));
        break;
      case "scroll":
        await this.page.mouse.wheel(0, Math.max(-4000, Math.min(4000, input.dy)));
        break;
      case "back":
        await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
        break;
      case "forward":
        await this.page.goForward({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
        break;
      case "reload":
        await this.page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
        break;
      default:
        throw new Error("unsupported_input");
    }
    await this.page.waitForTimeout(250);
    this.broadcast({ type: "input", at: new Date().toISOString(), action: input.type });
    return { ok: true, detail: input.type };
  }

  /**
   * Takes one AI-planned step on the same live page the owner is watching, so
   * the assistant can actually see and operate the session instead of a
   * parallel hidden browser.
   */
  async aiStep(instruction: string): Promise<{ thought: string; action: AgentAction; result: string }> {
    if (this.closed) throw new Error("live_session_closed");
    this.lastActivity = Date.now();
    const policy = policyFor(this.account.platform);
    let current: PageSnapshot;
    try {
      current = await snapshot(this.page);
    } catch {
      current = { url: this.page.url(), title: "", text: "", elements: [], capturedAt: new Date().toISOString() };
    }
    const planner = new AppLlmPlanner();
    let decision;
    try {
      decision = await planner.next({
        goal: instruction,
        step: 1,
        maxSteps: 1,
        platform: this.account.platform,
        mode: "agent",
        policy: { actionMode: policy.actionMode, actionNote: policy.actionNote, draftAllowed: policy.draftAllowed, label: policy.label },
        snapshot: current,
        history: this.lastAiHistory.slice(-8),
      });
    } catch (error) {
      if (error instanceof PlannerUnavailableError) throw new Error(`planner_unavailable:${error.message}`);
      throw error;
    }

    this.broadcast({ type: "notice", at: new Date().toISOString(), message: decision.thought || "خطوة وكيل" });
    const result = await this.executeAiAction(decision.action, policyHosts(this.account));
    this.lastAiHistory.push({ action: decision.action.kind, result });
    await this.page.waitForTimeout(300);
    return { thought: decision.thought, action: decision.action, result };
  }

  private async executeAiAction(action: AgentAction, allowedHosts: string[]): Promise<string> {
    switch (action.kind) {
      case "goto":
        await goto(this.page, action.url, allowedHosts);
        return "navigated";
      case "click":
        await clickRef(this.page, action.ref);
        return "clicked";
      case "type":
        await typeIntoRef(this.page, action.ref, action.text, action.submit);
        return "typed";
      case "scroll":
        await this.page.mouse.wheel(0, action.direction === "down" ? action.amount ?? 800 : -(action.amount ?? 800));
        return "scrolled";
      case "wait":
        await this.page.waitForTimeout(action.ms);
        return "waited";
      case "read_page":
        return (await readText(this.page)).slice(0, 4000);
      case "finish":
        return action.summary;
      case "draft_action":
        return "draft_requires_task_mode";
      default:
        return "unsupported";
    }
  }

  async visibleText(): Promise<string> {
    return readText(this.page);
  }

  async finish(): Promise<{ status: string; url: string }> {
    const state = await exportState(this.context);
    await accounts.saveSessionState(this.account.id, state);
    const url = this.page.url();
    await this.close("finished");
    return { status: "saved", url: redact(url, 400) };
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    try {
      const state = await exportState(this.context);
      await accounts.saveSessionState(this.account.id, state);
    } catch {
      // ignore state export failures on shutdown
    }
    await this.context.close().catch(() => undefined);
    this.broadcast({ type: "closed", at: new Date().toISOString(), reason });
    await audit.append({ accountId: this.account.id, platform: this.account.platform, event: "live_session_closed", detail: reason });
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

const SAFE_KEYS = new Set([
  "Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "Space", "Control+A", "Meta+A",
]);

function safeKey(value: string): string {
  if (SAFE_KEYS.has(value)) return value;
  if (/^[A-Za-z0-9]$/.test(value)) return value;
  throw new Error("unsupported_key");
}

export class LiveSessions {
  private readonly sessions = new Map<string, LiveSession>();

  async create(account: Account): Promise<LiveSession> {
    for (const existing of this.sessions.values()) {
      if (existing.account.id === account.id && !existing.isClosed) {
        await existing.close("replaced_by_new_login");
      }
    }
    const state = await accounts.loadSessionState(account.id);
    const session = await LiveSession.create(account, state);
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): LiveSession | null {
    const session = this.sessions.get(id);
    return session && !session.isClosed ? session : null;
  }

  async close(id: string, reason = "closed_by_owner"): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    await session.close(reason);
    this.sessions.delete(id);
    return true;
  }

  async closeAll(): Promise<void> {
    for (const [id, session] of this.sessions) {
      await session.close("shutdown");
      this.sessions.delete(id);
    }
  }
}

export const liveSessions = new LiveSessions();
