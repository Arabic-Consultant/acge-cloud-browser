import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertRuntimeConfig, config } from "./config.js";
import { accounts, audit } from "./store.js";
import { verifySession, closeBrowser } from "./browser.js";
import { liveSessions } from "./live.js";
import { agentTasks } from "./agent.js";
import { platformHosts } from "./policy.js";

const VERSION = "1.0.0";
const MAX_BODY = 64 * 1024;

type Handler = (request: IncomingMessage, response: ServerResponse, params: string[]) => Promise<void>;

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function authorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = config.token;
  if (!provided || provided.length !== expected.length) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) throw new Error("payload_too_large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

function startSse(response: ServerResponse): (event: unknown) => void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(": connected\n\n");
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, 15_000);
  heartbeat.unref?.();
  response.on("close", () => clearInterval(heartbeat));
  return (event: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

const accountCreateSchema = z.object({
  platform: z.enum(["facebook", "instagram", "whatsapp", "linkedin", "custom"]),
  label: z.string().trim().min(1).max(120),
  startUrl: z.string().url().max(500).optional(),
  loginUrl: z.string().url().max(500).optional(),
  inboxUrl: z.string().url().max(500).optional(),
});

const inputSchema = z.union([
  z.object({ type: z.literal("click"), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  z.object({ type: z.literal("type"), text: z.string().min(1).max(1000) }),
  z.object({ type: z.literal("key"), key: z.string().min(1).max(20) }),
  z.object({ type: z.literal("goto"), url: z.string().url().max(500) }),
  z.object({ type: z.literal("scroll"), dy: z.number().min(-4000).max(4000) }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("forward") }),
  z.object({ type: z.literal("reload") }),
]);

const taskSchema = z.object({
  accountId: z.string().min(4).max(60),
  goal: z.string().trim().min(3).max(1200),
  mode: z.enum(["read", "agent"]).default("agent"),
});

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  {
    method: "GET",
    pattern: /^\/health$/,
    handler: async (_request, response) => {
      json(response, 200, {
        ok: true,
        service: "acge-cloud-browser",
        version: VERSION,
        accounts: (await accounts.list()).length,
        plannerConfigured: Boolean(config.appUrl),
        concurrency: { liveSessions: "unbounded-by-token", tasks: config.maxTaskSteps },
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/accounts$/,
    handler: async (_request, response) => {
      const list = await accounts.list();
      json(response, 200, { accounts: list });
    },
  },
  {
    method: "POST",
    pattern: /^\/accounts$/,
    handler: async (request, response) => {
      const parsed = accountCreateSchema.safeParse(await readBody(request));
      if (!parsed.success) return json(response, 400, { error: "invalid_request", details: parsed.error.flatten() });
      if (parsed.data.platform === "custom" && !parsed.data.startUrl) {
        return json(response, 400, { error: "start_url_required" });
      }
      const account = await accounts.create(parsed.data);
      await audit.append({ accountId: account.id, platform: account.platform, event: "account_created", detail: account.startUrl });
      json(response, 201, { account });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/accounts\/([\w-]+)$/,
    handler: async (_request, response, [id]) => {
      const removed = await accounts.remove(id);
      if (!removed) return json(response, 404, { error: "account_not_found" });
      await audit.append({ accountId: id, event: "account_removed" });
      json(response, 200, { removed: true });
    },
  },
  {
    method: "POST",
    pattern: /^\/accounts\/([\w-]+)\/verify$/,
    handler: async (_request, response, [id]) => {
      const account = await accounts.get(id);
      if (!account) return json(response, 404, { error: "account_not_found" });
      const state = await accounts.loadSessionState(account.id);
      const verdict = await verifySession(account, state);
      await accounts.update(account.id, {
        status: verdict.status === "verified" ? "verified" : verdict.status === "expired" ? "expired" : "unverified",
        lastVerifiedAt: new Date().toISOString(),
        lastUrl: verdict.url,
        lastError: verdict.status === "verified" ? null : verdict.detail,
      });
      await audit.append({
        accountId: account.id,
        platform: account.platform,
        event: "session_verified",
        detail: `${verdict.status}:${verdict.detail}`,
        executed: false,
        verified: verdict.status === "verified",
      });
      json(response, 200, verdict);
    },
  },
  {
    method: "POST",
    pattern: /^\/accounts\/([\w-]+)\/login$/,
    handler: async (_request, response, [id]) => {
      const account = await accounts.get(id);
      if (!account) return json(response, 404, { error: "account_not_found" });
      if (account.platform !== "custom") {
        // Ensure the login host is validated before a live session starts.
        platformHosts(account.platform, account.startUrl);
      }
      const session = await liveSessions.create(account);
      json(response, 201, {
        sessionId: session.id,
        accountId: account.id,
        platform: account.platform,
        loginUrl: account.loginUrl,
        expiresInSeconds: Math.floor(config.liveTtlMs / 1000),
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/live\/([\w-]+)$/,
    handler: async (request, response, [id]) => {
      const session = liveSessions.get(id);
      if (!session) return json(response, 404, { error: "live_session_not_found" });
      const send = startSse(response);
      const unsubscribe = session.subscribe(send);
      request.on("close", () => unsubscribe());
    },
  },
  {
    method: "POST",
    pattern: /^\/live\/([\w-]+)\/input$/,
    handler: async (request, response, [id]) => {
      const session = liveSessions.get(id);
      if (!session) return json(response, 404, { error: "live_session_not_found" });
      const parsed = inputSchema.safeParse(await readBody(request));
      if (!parsed.success) return json(response, 400, { error: "invalid_input" });
      const result = await session.applyInput(parsed.data);
      json(response, 200, result);
    },
  },
  {
    method: "POST",
    pattern: /^\/live\/([\w-]+)\/ai$/,
    handler: async (request, response, [id]) => {
      const session = liveSessions.get(id);
      if (!session) return json(response, 404, { error: "live_session_not_found" });
      const body = (await readBody(request)) as { instruction?: unknown };
      if (typeof body.instruction !== "string" || body.instruction.trim().length < 3 || body.instruction.length > 600) {
        return json(response, 400, { error: "instruction_required" });
      }
      try {
        const result = await session.aiStep(body.instruction.trim());
        json(response, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "ai_step_failed";
        json(response, message.startsWith("planner_unavailable") ? 503 : 500, {
          error: "ai_step_failed",
          message: message.startsWith("planner_unavailable")
            ? "مزوّد الذكاء الاصطناعي غير مهيأ أو منتهي الحصة."
            : message,
        });
      }
    },
  },
  {
    method: "POST",
    pattern: /^\/live\/([\w-]+)\/finish$/, 
    handler: async (_request, response, [id]) => {
      const session = liveSessions.get(id);
      if (!session) return json(response, 404, { error: "live_session_not_found" });
      const account = session.account;
      const result = await session.finish();
      const state = await accounts.loadSessionState(account.id);
      const verdict = await verifySession(account, state).catch(() => ({ status: "unverified" as const, url: result.url, detail: "verification_failed" }));
      await accounts.update(account.id, {
        status: verdict.status,
        lastVerifiedAt: new Date().toISOString(),
        lastUrl: verdict.url,
        lastError: verdict.status === "verified" ? null : verdict.detail,
      });
      json(response, 200, { ...result, verification: verdict });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/live\/([\w-]+)$/,
    handler: async (_request, response, [id]) => {
      const closed = await liveSessions.close(id);
      if (!closed) return json(response, 404, { error: "live_session_not_found" });
      json(response, 200, { closed: true });
    },
  },
  {
    method: "GET",
    pattern: /^\/tasks$/,
    handler: async (_request, response) => {
      json(response, 200, { tasks: agentTasks.list() });
    },
  },
  {
    method: "POST",
    pattern: /^\/tasks$/,
    handler: async (request, response) => {
      const parsed = taskSchema.safeParse(await readBody(request));
      if (!parsed.success) return json(response, 400, { error: "invalid_request", details: parsed.error.flatten() });
      const account = await accounts.get(parsed.data.accountId);
      if (!account) return json(response, 404, { error: "account_not_found" });
      const task = await agentTasks.start(account, { goal: parsed.data.goal, mode: parsed.data.mode });
      json(response, 202, { task });
    },
  },
  {
    method: "GET",
    pattern: /^\/tasks\/([\w-]+)$/,
    handler: async (_request, response, [id]) => {
      const task = agentTasks.get(id);
      if (!task) return json(response, 404, { error: "task_not_found" });
      json(response, 200, { task: task.toJSON() });
    },
  },
  {
    method: "GET",
    pattern: /^\/tasks\/([\w-]+)\/events$/,
    handler: async (request, response, [id]) => {
      const task = agentTasks.get(id);
      if (!task) return json(response, 404, { error: "task_not_found" });
      const send = startSse(response);
      for (const event of task.toJSON().events) send(event);
      const unsubscribe = task.subscribe(send);
      request.on("close", () => unsubscribe());
    },
  },
  {
    method: "POST",
    pattern: /^\/tasks\/([\w-]+)\/approve$/,
    handler: async (request, response, [id]) => {
      const body = (await readBody(request)) as { approvalId?: unknown };
      if (typeof body.approvalId !== "string") return json(response, 400, { error: "approval_id_required" });
      try {
        const result = await agentTasks.approve(id, body.approvalId);
        json(response, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "approval_failed";
        const status = message === "task_not_found" ? 404 : message === "platform_read_only" || message === "linkedin_automation_prohibited" ? 403 : 409;
        json(response, status, { error: message });
      }
    },
  },
  {
    method: "POST",
    pattern: /^\/tasks\/([\w-]+)\/cancel$/,
    handler: async (_request, response, [id]) => {
      const cancelled = await agentTasks.cancel(id);
      json(response, cancelled ? 200 : 409, { cancelled });
    },
  },
  {
    method: "GET",
    pattern: /^\/audit$/,
    handler: async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      json(response, 200, { entries: await audit.list(Number.isFinite(limit) ? limit : 50) });
    },
  },
];

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const candidates = routes.filter((route) => route.method === request.method);

  for (const route of candidates) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    if (path !== "/health" && !authorized(request)) {
      return json(response, 401, { error: "unauthorized" });
    }
    const params = match.slice(1);
    route.handler(request, response, params).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "internal_error";
      if (response.headersSent) {
        response.end();
        return;
      }
      json(response, message === "payload_too_large" ? 413 : message === "invalid_json" ? 400 : 500, {
        error: message.startsWith("live_session") || message.startsWith("action_") || message.startsWith("unsupported") ? message : "request_failed",
        message,
      });
    });
    return;
  }
  json(response, 404, { error: "not_found" });
});

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ status: "shutting_down", signal }));
  await liveSessions.closeAll().catch(() => undefined);
  await closeBrowser().catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}

if (process.env.NODE_ENV !== "test") {
  try {
    assertRuntimeConfig();
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : "invalid_config" }));
    process.exit(1);
  }
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    console.log(JSON.stringify({ status: "listening", port, dataDir: config.dataDir, headless: config.headless }));
  });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

export { server };
