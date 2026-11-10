import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { startFixture } from "./fixture-site.js";
import { startMockPlanner } from "./mock-planner.js";
import { makeDataDir, RuntimeClient, startRuntime, waitFor } from "./harness.js";

const CONTENT = "شكراً لتواصلكم. نرسل لكم تفاصيل البرنامج والسعر خلال يوم عمل واحد.";

type TaskPayload = {
  id: string;
  status: string;
  summary: string | null;
  findings: Array<{ title: string }>;
  content: string | null;
  pendingApproval: { id: string; content: string; target: string } | null;
  events: Array<{ type: string; message: string }>;
};

async function fetchTask(client: RuntimeClient, id: string): Promise<TaskPayload> {
  const response = await client.request<{ task: TaskPayload }>(`/tasks/${id}`);
  assert.equal(response.status, 200);
  return response.data.task;
}

test("cloud browser runtime: real Chromium, persistent encrypted session, read task, approval-gated send", async (t) => {
  const fixture = await startFixture();
  const mock = await startMockPlanner({ fixtureUrl: fixture.url, content: CONTENT });
  const dataDir = await makeDataDir();
  const encryptionKey = randomBytes(32).toString("base64");
  const baseEnv = { APP_URL: mock.url, BROWSER_AGENT_ACTION_COOLDOWN_MS: "0", BROWSER_AGENT_ENCRYPTION_KEY: encryptionKey };
  let runtime = await startRuntime({ dataDir, extraEnv: baseEnv });
  let client = new RuntimeClient(runtime.url, runtime.token);

  t.after(async () => {
    await runtime.stop().catch(() => undefined);
    await mock.close().catch(() => undefined);
    await fixture.close().catch(() => undefined);
  });

  const health = await fetch(`${runtime.url}/health`).then((response) => response.json());
  assert.equal((health as { ok: boolean }).ok, true);

  await t.test("rejects unauthenticated access", async () => {
    const response = await fetch(`${runtime.url}/accounts`);
    assert.equal(response.status, 401);
  });

  const created = await client.request<{ account: { id: string; status: string; hasStoredSession: boolean } }>("/accounts", {
    method: "POST",
    body: {
      platform: "custom",
      label: "حساب اختبار محلي",
      startUrl: `${fixture.url}/inbox`,
      loginUrl: `${fixture.url}/login`,
      inboxUrl: `${fixture.url}/inbox`,
    },
  });
  assert.equal(created.status, 201);
  const accountId = created.data.account.id;
  assert.equal(created.data.account.status, "unverified");
  assert.equal(created.data.account.hasStoredSession, false);

  await t.test("a new profile without a login is not reported as connected", async () => {
    const verdict = await client.request<{ status: string }>(`/accounts/${accountId}/verify`, { method: "POST" });
    assert.equal(verdict.status, 200);
    assert.equal(verdict.data.status, "expired");
  });

  await t.test("live login streams real browser frames and accepts human input", async () => {
    const login = await client.request<{ sessionId: string }>(`/accounts/${accountId}/login`, { method: "POST" });
    assert.equal(login.status, 201);
    const sessionId = login.data.sessionId;

    const events: Array<Record<string, unknown>> = [];
    const streamDone = { closed: false };
    void client
      .streamEvents(`/live/${sessionId}`, (event) => events.push(event), () => streamDone.closed)
      .catch(() => undefined);

    const firstFrame = await waitFor(() => {
      const frame = events.find((event) => event.type === "frame");
      return frame ? frame : null;
    }, 40_000);
    assert.equal(typeof firstFrame.image, "string");
    assert.ok(String(firstFrame.image).startsWith("/9j/"), "frame must be a real JPEG capture");
    assert.equal(firstFrame.width, 1280);

    await client.request(`/live/${sessionId}/input`, { method: "POST", body: { type: "type", text: "owner" } });
    await client.request(`/live/${sessionId}/input`, { method: "POST", body: { type: "key", key: "Tab" } });
    await client.request(`/live/${sessionId}/input`, { method: "POST", body: { type: "type", text: "secret-pass" } });
    await client.request(`/live/${sessionId}/input`, { method: "POST", body: { type: "key", key: "Enter" } });

    await waitFor(() => events.find((event) => event.type === "meta" && String(event.url).includes("/inbox")) ?? null, 30_000);

    const finished = await client.request<{ verification: { status: string; detail: string } }>(`/live/${sessionId}/finish`, { method: "POST" });
    assert.equal(finished.status, 200);
    assert.equal(finished.data.verification.status, "verified");
    streamDone.closed = true;
  });

  await t.test("session survives a full runtime restart (encrypted storageState)", async () => {
    await runtime.stop();
    runtime = await startRuntime({ dataDir, extraEnv: baseEnv });
    client = new RuntimeClient(runtime.url, runtime.token);
    const list = await client.request<{ accounts: Array<{ id: string; hasStoredSession: boolean }> }>("/accounts");
    assert.equal(list.data.accounts[0].hasStoredSession, true);
    const verdict = await client.request<{ status: string; detail: string }>(`/accounts/${accountId}/verify`, { method: "POST" });
    assert.equal(verdict.data.status, "verified", `expected verified session after restart, got ${verdict.data.detail}`);
  });

  await t.test("read-only task extracts real page content", async () => {
    const started = await client.request<{ task: TaskPayload }>("/tasks", { method: "POST", body: { accountId, goal: "راجع الرسائل الجديدة", mode: "read" } });
    assert.equal(started.status, 202);
    const taskId = started.data.task.id;
    const task = await waitFor(async () => {
      const current = await fetchTask(client, taskId);
      return ["completed", "failed", "expired"].includes(current.status) ? current : null;
    }, 90_000);
    assert.equal(task.status, "completed", JSON.stringify(task.events));
    assert.ok(task.findings.length >= 3, `expected at least 3 extracted items, got ${task.findings.length} :: ${JSON.stringify(task.events)} :: ${(task.content ?? "").slice(0, 400)}`);
    assert.match(task.content ?? "", /شركة النور/);
  });

  await t.test("agent drafts inside the composer and refuses to send without approval", async () => {
    const started = await client.request<{ task: TaskPayload }>("/tasks", {
      method: "POST",
      body: { accountId, goal: "افتح محادثة شركة النور واكتب رداً مناسباً", mode: "agent" },
    });
    assert.equal(started.status, 202);
    const taskId = started.data.task.id;
    const pending = await waitFor(async () => {
      const current = await fetchTask(client, taskId);
      if (current.status === "failed") throw new Error(`task_failed: ${current.events.at(-1)?.message ?? ""}`);
      return current.status === "awaiting_approval" ? current : null;
    }, 90_000);
    assert.ok(pending.pendingApproval, `task must publish a pending approval: ${JSON.stringify(pending.events)}`);
    assert.equal(pending.pendingApproval?.content, CONTENT);

    const before = (await fetch(`${fixture.url}/api/state`).then((response) => response.json())) as { sent: unknown[] };
    assert.equal(before.sent.length, 0, "nothing may be sent before approval");

    const approved = await client.request<{ executed: boolean; verified: boolean; detail: string }>(`/tasks/${taskId}/approve`, {
      method: "POST",
      body: { approvalId: pending.pendingApproval?.id },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.executed, true);
    assert.equal(approved.data.verified, true, `provider did not confirm the send: ${approved.data.detail}`);

    const after = (await fetch(`${fixture.url}/api/state`).then((response) => response.json())) as { sent: Array<{ text: string }> };
    assert.equal(after.sent.length, 1);
    assert.equal(after.sent[0].text, CONTENT);

    const done = await fetchTask(client, taskId);
    assert.equal(done.status, "completed");
    assert.match(done.summary ?? "", /تم إرسال الرسالة/);
  });

  await t.test("cancelling a drafted action never sends", async () => {
    const started = await client.request<{ task: TaskPayload }>("/tasks", {
      method: "POST",
      body: { accountId, goal: "جهّز رداً آخر", mode: "agent" },
    });
    const taskId = started.data.task.id;
    await waitFor(async () => {
      const current = await fetchTask(client, taskId);
      return current.status === "awaiting_approval" ? current : null;
    }, 90_000);
    const cancelled = await client.request<{ cancelled: boolean }>(`/tasks/${taskId}/cancel`, { method: "POST" });
    assert.equal(cancelled.data.cancelled, true);
    const state = (await fetch(`${fixture.url}/api/state`).then((response) => response.json())) as { sent: unknown[] };
    assert.equal(state.sent.length, 1, "cancel must not send anything new");
    const task = await fetchTask(client, taskId);
    assert.equal(task.status, "cancelled");
  });

  await t.test("audit log records the approved action without secrets", async () => {
    const log = await client.request<{ entries: Array<{ event: string; executed?: boolean; detail?: string }> }>("/audit?limit=50");
    assert.equal(log.status, 200);
    const executed = log.data.entries.find((entry) => entry.event === "approved_action_executed");
    assert.ok(executed, "approved action must be audited");
    assert.equal(executed?.executed, true);
    assert.doesNotMatch(JSON.stringify(log.data.entries), /sid=ok|Bearer\s+[A-Za-z0-9]/);
  });
});
