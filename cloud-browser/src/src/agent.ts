import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { config } from "./config.js";
import { exportState, openContext, policyHosts } from "./browser.js";
import { clickRef, composerContent, findSendControl, readText, snapshot, typeIntoRef, type PageSnapshot } from "./extract.js";
import { actionExecutionBlocked, policyFor, redact } from "./policy.js";
import { AppLlmPlanner, PlannerUnavailableError, ReadOnlyPlanner, type AgentAction, type Finding, type Planner, type PlannerStep } from "./planner.js";
import { actionBudget, accounts, audit, type Account } from "./store.js";
import { assertNavigableUrl, UrlBlockedError } from "./url-guard.js";

export type TaskEvent = {
  seq: number;
  at: string;
  type: "started" | "thought" | "action" | "result" | "blocked" | "approval_required" | "approval_executed" | "completed" | "failed" | "cancelled" | "expired" | "log";
  message: string;
  data?: Record<string, unknown>;
};

export type PendingApproval = {
  id: string;
  kind: "send_message";
  target: string;
  content: string;
  rationale: string;
  sendRef: string;
  pageUrl: string;
  createdAt: string;
  expiresAt: string;
};

export type TaskStatus = "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "expired";

export type Task = {
  id: string;
  accountId: string;
  platform: string;
  accountLabel: string;
  goal: string;
  mode: "read" | "agent";
  status: TaskStatus;
  createdAt: string;
  finishedAt: string | null;
  step: number;
  pageUrl: string | null;
  summary: string | null;
  findings: Finding[];
  content: string | null;
  pendingApproval: PendingApproval | null;
  error: string | null;
  events: TaskEvent[];
};

type Runtime = { context: BrowserContext; page: Page; snapshot: PageSnapshot | null };

class TaskRecord implements Task {
  readonly id = `task_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  readonly createdAt = new Date().toISOString();
  status: TaskStatus = "running";
  finishedAt: string | null = null;
  step = 0;
  pageUrl: string | null = null;
  summary: string | null = null;
  findings: Finding[] = [];
  content: string | null = null;
  pendingApproval: PendingApproval | null = null;
  error: string | null = null;
  events: TaskEvent[] = [];
  runtime: Runtime | null = null;
  private seq = 0;
  private subscribers = new Set<(event: TaskEvent) => void>();
  private approvalTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly accountId: string,
    readonly platform: string,
    readonly accountLabel: string,
    readonly goal: string,
    readonly mode: "read" | "agent",
  ) {}

  emit(type: TaskEvent["type"], message: string, data?: Record<string, unknown>): void {
    const event: TaskEvent = { seq: ++this.seq, at: new Date().toISOString(), type, message: redact(message, 1200), data };
    this.events.push(event);
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  subscribe(subscriber: (event: TaskEvent) => void): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  toJSON(): Task {
    return {
      id: this.id,
      accountId: this.accountId,
      platform: this.platform,
      accountLabel: this.accountLabel,
      goal: this.goal,
      mode: this.mode,
      status: this.status,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      step: this.step,
      pageUrl: this.pageUrl,
      summary: this.summary,
      findings: this.findings,
      content: this.content,
      pendingApproval: this.pendingApproval,
      error: this.error,
      events: this.events.slice(-120),
    };
  }

  armApprovalExpiry(onExpire: () => Promise<void>): void {
    this.clearApprovalExpiry();
    this.approvalTimer = setTimeout(() => {
      void onExpire().catch(() => undefined);
    }, config.approvalTtlMs);
    this.approvalTimer.unref?.();
  }

  clearApprovalExpiry(): void {
    if (this.approvalTimer) clearTimeout(this.approvalTimer);
    this.approvalTimer = null;
  }
}

export class AgentTasks {
  private readonly tasks = new Map<string, TaskRecord>();

  async start(account: Account, input: { goal: string; mode: "read" | "agent" }): Promise<Task> {
    const task = new TaskRecord(account.id, account.platform, account.label, input.goal, input.mode);
    this.tasks.set(task.id, task);
    this.prune();
    void this.run(account, task).catch(async (error) => {
      await this.fail(task, error);
    });
    return task.toJSON();
  }

  get(id: string): TaskRecord | null {
    return this.tasks.get(id) ?? null;
  }

  list(): Task[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
      .map((task) => task.toJSON());
  }

  private prune(): void {
    const finished = Array.from(this.tasks.values())
      .filter((task) => ["completed", "failed", "cancelled", "expired"].includes(task.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (finished.length > 30) {
      const oldest = finished.shift();
      if (oldest) this.tasks.delete(oldest.id);
    }
  }

  private plannerFor(account: Account, task: TaskRecord): Planner {
    if (task.mode === "read") return new ReadOnlyPlanner(account.inboxUrl || account.startUrl);
    return new AppLlmPlanner();
  }

  private async run(account: Account, task: TaskRecord): Promise<void> {
    const policy = policyFor(account.platform);
    const hosts = policyHosts(account);
    const store = await accounts.loadSessionState(account.id);
    const { context, page } = await openContext({ account, allowedHosts: hosts, storageState: store });
    task.runtime = { context, page, snapshot: null } as Runtime;
    task.emit("started", `بدأت المهمة على ${policy.label} (${account.label}) في متصفح سحابي حقيقي.`, { platform: account.platform });

    const timeout = setTimeout(() => {
      void this.fail(task, new Error("task_timeout"));
    }, config.taskTimeoutMs);
    timeout.unref?.();

    try {
      const planner = this.plannerFor(account, task);
      let lastResult = "بداية المهمة";
      for (let step = 1; step <= config.maxTaskSteps; step += 1) {
        if (task.status !== "running") return;
        task.step = step;
        let current: PageSnapshot;
        try {
          current = await snapshot(page);
        } catch (error) {
          task.emit("log", `تعذرت قراءة بنية الصفحة: ${error instanceof Error ? error.message : "snapshot_failed"}`);
          current = { url: page.url(), title: "", text: "", elements: [], capturedAt: new Date().toISOString() };
        }
        task.runtime.snapshot = current;
        task.pageUrl = redact(current.url, 400);

        const plannerStep: PlannerStep = {
          goal: task.goal,
          step,
          maxSteps: config.maxTaskSteps,
          platform: account.platform,
          mode: task.mode,
          policy: { actionMode: policy.actionMode, actionNote: policy.actionNote, draftAllowed: policy.draftAllowed, label: policy.label },
          snapshot: current,
          history: task.events
            .filter((event) => event.type === "action" || event.type === "result")
            .slice(-10)
            .map((event) => ({ action: event.type, result: event.message })),
        };

        let decision;
        try {
          decision = await planner.next(plannerStep);
        } catch (error) {
          if (error instanceof PlannerUnavailableError) {
            await this.fail(task, new Error(`planner_unavailable:${error.message}`));
            return;
          }
          throw error;
        }

        if (decision.thought) task.emit("thought", decision.thought);

        const action = decision.action;
        if (action.kind === "finish") {
          task.summary = action.summary;
          task.findings = action.findings;
          task.content = current.text;
          task.emit("result", action.summary, { findings: action.findings.length });
          break;
        }

        if (action.kind === "draft_action") {
          const drafted = await this.draft(page, task, action);
          if (!drafted) return;
          lastResult = `مسودة (${action.target})`;
          continue;
        }

        lastResult = await this.execute(page, task, action, hosts);
        if (task.status !== "running") return;
      }

      if (task.status === "awaiting_approval") {
        await this.persist(account, task);
        return;
      }
      if (!task.summary) {
        task.summary = `انتهى الحد الأقصى للخطوات (${config.maxTaskSteps}) دون إعلان الوكيل انتهاء المهمة. آخر خطوة: ${lastResult}`;
      }
      task.status = "completed";
      task.finishedAt = new Date().toISOString();
      if (!task.content) task.content = await readText(page).catch(() => "");
      task.emit("completed", task.summary);
      await this.persist(account, task);
      await audit.append({
        accountId: account.id,
        platform: account.platform,
        taskId: task.id,
        event: "task_completed",
        detail: task.summary,
        executed: false,
        verified: true,
      });
    } finally {
      clearTimeout(timeout);
      if (task.status !== "awaiting_approval") await this.closeRuntime(task);
    }
  }

  private async execute(page: Page, task: TaskRecord, action: AgentAction, hosts: string[]): Promise<string> {
    switch (action.kind) {
      case "goto": {
        try {
          const url = await assertNavigableUrl(action.url, hosts);
          await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
          task.emit("action", `فتح الصفحة: ${redact(url.toString(), 300)}`);
          return "navigated";
        } catch (error) {
          const message = error instanceof UrlBlockedError ? `حجب الانتقال خارج نطاق المنصة/الحساب (${error.message}).` : "تعذر فتح الصفحة المطلوبة.";
          task.emit("blocked", message);
          return message;
        }
      }
      case "click": {
        try {
          await clickRef(page, action.ref);
          await page.waitForTimeout(700);
          task.emit("action", `ضغط على العنصر ${action.ref}${action.label ? ` (${action.label})` : ""}.`);
          return "clicked";
        } catch {
          task.emit("action", `تعذر الضغط على العنصر ${action.ref}؛ سيعيد الوكيل التقييم.`);
          return "click_failed";
        }
      }
      case "type": {
        try {
          await typeIntoRef(page, action.ref, action.text, action.submit);
          task.emit("action", `كتابة نص في الحقل ${action.ref}${action.submit ? " مع Enter" : ""}.`, { length: action.text.length });
          return "typed";
        } catch {
          task.emit("action", `تعذر الكتابة في الحقل ${action.ref}.`);
          return "type_failed";
        }
      }
      case "scroll": {
        const amount = action.amount ?? 800;
        await page.mouse.wheel(0, action.direction === "down" ? amount : -amount);
        await page.waitForTimeout(500);
        task.emit("action", `تمرير الصفحة ${action.direction === "down" ? "للأسفل" : "للأعلى"}.`);
        return "scrolled";
      }
      case "wait": {
        await page.waitForTimeout(action.ms);
        task.emit("action", `انتظار ${action.ms} مللي ثانية.`);
        return "waited";
      }
      case "read_page": {
        const text = await readText(page);
        task.emit("result", `قراءة ${text.length} حرفاً من الصفحة الحالية.`, { characters: text.length });
        return "read";
      }
      default:
        return "unsupported";
    }
  }

  /**
   * Fills the composer but never presses the final control. The task then
   * persists its browser session and waits for explicit owner approval.
   */
  private async draft(page: Page, task: TaskRecord, action: Extract<AgentAction, { kind: "draft_action" }>): Promise<boolean> {
    const policy = policyFor(task.platform as Account["platform"]);
    if (!policy.draftAllowed) {
      task.emit("blocked", "سياسة هذا الحساب لا تسمح بتجهيز رسالة.");
      return false;
    }
    let composer = null;
    for (const selector of policy.composerSelectors) {
      const candidate = page.locator(selector).last();
      if (await candidate.count().catch(() => 0)) {
        composer = candidate;
        break;
      }
    }
    if (!composer) {
      task.emit("blocked", "لم يُعثر على مربع كتابة الرسالة. يلزم فتح المحادثة المستهدفة أولاً.");
      return false;
    }
    await composer.click({ timeout: 10_000 }).catch(() => undefined);
    await page.keyboard.insertText(action.content);
    await page.waitForTimeout(400);

    const before = countOccurrences(await readText(page).catch(() => ""), action.content);
    const send = await findSendControl(page, policy);
    if (!send) {
      task.emit("blocked", "لم يُعثر على زر الإرسال؛ لن ينفذ النظام أي إجراء غير محدد.");
      return false;
    }
    task.pendingApproval = {
      id: `apr_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      kind: "send_message",
      target: action.target,
      content: action.content,
      rationale: action.rationale,
      sendRef: send.ref,
      pageUrl: redact(page.url(), 400),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + config.approvalTtlMs).toISOString(),
    };
    task.status = "awaiting_approval";
    task.content = (await readText(page).catch(() => "")) || null;
    task.emit("approval_required", `المسودة جاهزة إلى «${action.target}» داخل المتصفح. بانتظار موافقتك لضغط زر الإرسال.`, {
      approvalId: task.pendingApproval.id,
      target: action.target,
      content: action.content,
      occurrencesBefore: before,
    });
    task.armApprovalExpiry(async () => {
      task.clearApprovalExpiry();
      if (task.status === "awaiting_approval") {
        task.status = "expired";
        task.error = "approval_expired";
        task.finishedAt = new Date().toISOString();
        task.emit("expired", "انتهت مدة الموافقة قبل التنفيذ، ولم يُرسل شيء.");
        await this.closeRuntime(task);
      }
    });
    return true;
  }

  async approve(taskId: string, approvalId: string): Promise<{ executed: boolean; verified: boolean; detail: string }> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("task_not_found");
    if (task.status !== "awaiting_approval" || !task.pendingApproval) throw new Error("no_pending_approval");
    if (task.pendingApproval.id !== approvalId) throw new Error("approval_mismatch");
    if (Date.parse(task.pendingApproval.expiresAt) < Date.now()) throw new Error("approval_expired");
    if (!task.runtime) throw new Error("session_unavailable");

    const account = await accounts.get(task.accountId);
    if (!account) throw new Error("account_not_found");
    const blocked = actionExecutionBlocked(account.platform, config.allowLinkedinActions);
    if (blocked) {
      task.emit("blocked", `لم يُنفذ الإرسال: سياسة المنصة تمنع الأتمتة (${blocked}). يمكنك الإرسال يدوياً من نافذة المتصفح.`);
      await audit.append({ accountId: account.id, platform: account.platform, taskId: task.id, event: "action_blocked", detail: blocked, executed: false, verified: false });
      throw new Error(blocked);
    }
    await actionBudget.assertAllowed(account.id);

    const { page } = task.runtime;
    const approval = task.pendingApproval;
    task.clearApprovalExpiry();
    task.status = "running";

    if (page.url() !== approval.pageUrl) {
      task.status = "failed";
      task.error = "page_changed";
      task.emit("failed", "تغيّرت الصفحة منذ تجهيز المسودة؛ لم يُنفذ الإرسال لحماية الحساب.");
      await this.closeRuntime(task);
      return { executed: false, verified: false, detail: "page_changed" };
    }

    const selectors = policyFor(account.platform).composerSelectors;
    const beforeComposer = await composerContent(page, selectors);

    try {
      await clickRef(page, approval.sendRef);
    } catch {
      task.status = "failed";
      task.error = "send_control_unavailable";
      task.emit("failed", "تعذر الوصول إلى زر الإرسال؛ لم يُرسل شيء.");
      await this.closeRuntime(task);
      return { executed: false, verified: false, detail: "send_control_unavailable" };
    }

    await actionBudget.record(account.id);
    task.emit("approval_executed", `تم الضغط على زر الإرسال بعد موافقتك الصريحة إلى «${approval.target}».`);

    let verified = false;
    let detail = "unconfirmed";
    const needle = approval.content.slice(0, 40);
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      const afterText = await readText(page).catch(() => "");
      const afterComposer = await composerContent(page, selectors);
      const errorVisible = /(failed to send|couldn't send|not sent|تعذر الإرسال|لم يتم الإرسال|error sending)/i.test(afterText);
      if (errorVisible) {
        detail = "provider_error_visible";
        break;
      }
      const composerCleared = afterComposer === null || !afterComposer.includes(needle);
      if (composerCleared && afterText.includes(needle)) {
        verified = true;
        detail = beforeComposer === null ? "message_visible_in_thread" : "composer_cleared_and_message_visible";
        break;
      }
    }

    task.status = "completed";
    task.finishedAt = new Date().toISOString();
    task.pendingApproval = null;
    task.summary = verified
      ? `تم إرسال الرسالة إلى «${approval.target}» وتأكد ظهورها في المحادثة (${detail}).`
      : `تم الضغط على زر الإرسال إلى «${approval.target}» لكن الموقع لم يؤكد نجاح العملية (${detail}). راجع المحادثة يدوياً.`;
    task.emit("completed", task.summary, { executed: true, verified });
    await audit.append({
      accountId: account.id,
      platform: account.platform,
      taskId: task.id,
      event: "approved_action_executed",
      detail: `${approval.target}: ${detail}`,
      executed: true,
      verified,
    });
    await this.persist(account, task);
    await this.closeRuntime(task);
    return { executed: true, verified, detail };
  }

  async cancel(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (["completed", "failed", "cancelled", "expired"].includes(task.status)) return false;
    task.status = "cancelled";
    task.finishedAt = new Date().toISOString();
    task.clearApprovalExpiry();
    task.pendingApproval = null;
    task.emit("cancelled", "أُلغيت المهمة. لا يوجد أي إرسال قائم.");
    await this.closeRuntime(task);
    return true;
  }

  private async persist(account: Account, task: TaskRecord): Promise<void> {
    if (!task.runtime) return;
    try {
      const state = await exportState(task.runtime.context);
      await accounts.saveSessionState(account.id, state);
      await accounts.update(account.id, { lastUsedAt: new Date().toISOString(), lastUrl: task.pageUrl });
    } catch {
      // state persistence failure must not crash the task result
    }
  }

  private async closeRuntime(task: TaskRecord): Promise<void> {
    if (!task.runtime) return;
    const { context } = task.runtime;
    task.runtime = null;
    await context.close().catch(() => undefined);
  }

  private async fail(task: TaskRecord, error: unknown): Promise<void> {
    if (task.status === "failed") return;
    const message = error instanceof Error ? error.message : "task_failed";
    task.status = "failed";
    task.error = message.slice(0, 300);
    task.finishedAt = new Date().toISOString();
    task.emit("failed", message.startsWith("planner_unavailable")
      ? "لا يوجد مزوّد ذكاء اصطناعي مهيأ لتنفيذ مهمة موجّهة. استخدم وضع القراءة أو أضف مفتاح مزوّد من صفحة النماذج."
      : `تعذر إكمال المهمة: ${message}`);
    await this.closeRuntime(task);
    await audit.append({ accountId: task.accountId, platform: task.platform as Account["platform"], taskId: task.id, event: "task_failed", detail: message, executed: false, verified: false });
  }
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export const agentTasks = new AgentTasks();
