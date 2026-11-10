import { resolve } from "node:path";

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

export const config = {
  port: int("BROWSER_AGENT_PORT", 8787, 0, 65_535),
  host: process.env.BROWSER_AGENT_HOST || "0.0.0.0",
  /** Bearer token required for every non-health endpoint. */
  token: process.env.BROWSER_AGENT_TOKEN ?? "",
  dataDir: resolve(process.env.BROWSER_AGENT_DATA_DIR || "./browser-data"),
  headless: bool("BROWSER_AGENT_HEADLESS", true),
  /** Browser viewport used for both live view and agent runs. */
  viewport: { width: 1280, height: 800 },
  liveTtlMs: int("BROWSER_AGENT_LIVE_TTL_MS", 15 * 60_000, 60_000, 6 * 60 * 60_000),
  liveFrameIntervalMs: int("BROWSER_AGENT_FRAME_INTERVAL_MS", 900, 250, 10_000),
  maxTaskSteps: int("BROWSER_AGENT_MAX_STEPS", 14, 1, 40),
  taskTimeoutMs: int("BROWSER_AGENT_TASK_TIMEOUT_MS", 6 * 60_000, 30_000, 30 * 60_000),
  /** Time an approved-action draft may stay open waiting for the owner. */
  approvalTtlMs: int("BROWSER_AGENT_APPROVAL_TTL_MS", 10 * 60_000, 60_000, 60 * 60_000),
  /** Dashboard endpoint that supplies the next agent step from the configured AI provider. */
  appUrl: (process.env.APP_URL || "").replace(/\/$/, ""),
  plannerPath: "/api/browser/agent/step",
  /**
   * Push encrypted sessions to the dashboard over HTTP. Disabled by default: the
   * GitHub runner persists /data as an Actions artifact instead.
   */
  remoteStore: bool("BROWSER_AGENT_REMOTE_STORE", false),
  /** Extra hosts the browser may navigate to (comma separated). */
  extraHosts: (process.env.BROWSER_AGENT_EXTRA_HOSTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
  allowPrivateHosts: bool("BROWSER_AGENT_ALLOW_PRIVATE_HOSTS", false),
  /** LinkedIn automation stays blocked unless the owner explicitly lifts it. */
  allowLinkedinActions: bool("BROWSER_AGENT_ALLOW_LINKEDIN_ACTIONS", false),
  /** Per-account automated action budget (approved sends only). */
  actionCooldownMs: int("BROWSER_AGENT_ACTION_COOLDOWN_MS", 45_000, 0, 60 * 60_000),
  actionDailyLimit: int("BROWSER_AGENT_ACTION_DAILY_LIMIT", 20, 1, 200),
  auditLimit: int("BROWSER_AGENT_AUDIT_LIMIT", 500, 20, 5000),
};

export function assertRuntimeConfig(): void {
  if (config.token.length < 24) {
    throw new Error("BROWSER_AGENT_TOKEN must be set to at least 24 characters");
  }
  if (!process.env.BROWSER_AGENT_ENCRYPTION_KEY && !process.env.CREDENTIALS_ENCRYPTION_KEY) {
    throw new Error("BROWSER_AGENT_ENCRYPTION_KEY must be configured");
  }
}
