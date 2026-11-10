import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { readEncryptedFile, writeEncryptedFile } from "./crypto.js";
import { policyFor, redact, type PlatformId } from "./policy.js";
import { fetchRemoteState, pushRemoteState, remoteStoreEnabled } from "./remote.js";

export type AccountStatus = "unverified" | "verified" | "expired" | "error";

export type Account = {
  id: string;
  platform: PlatformId;
  label: string;
  startUrl: string;
  loginUrl: string;
  inboxUrl?: string;
  status: AccountStatus;
  hasStoredSession: boolean;
  lastVerifiedAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  lastUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuditEntry = {
  id: string;
  at: string;
  accountId?: string;
  platform?: PlatformId;
  taskId?: string;
  event: string;
  detail?: string;
  executed?: boolean;
  verified?: boolean;
};

type ActionLedger = Record<string, string[]>;

const accountsFile = () => join(config.dataDir, "accounts.json");
const auditFile = () => join(config.dataDir, "audit.json");
const budgetFile = () => join(config.dataDir, "actions.json");
const profilePath = (accountId: string) => join(config.dataDir, "profiles", `${accountId}.state`);

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export class AccountStore {
  private accounts: Account[] | null = null;

  private async load(): Promise<Account[]> {
    if (this.accounts) return this.accounts;
    this.accounts = await readJson<Account[]>(accountsFile(), []);
    return this.accounts;
  }

  private async flush(): Promise<void> {
    await writeJson(accountsFile(), this.accounts ?? []);
  }

  async list(): Promise<Account[]> {
    const accounts = await this.load();
    return accounts
      .map((account) => ({ ...account, hasStoredSession: Boolean(account.hasStoredSession) }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<Account | null> {
    const accounts = await this.load();
    return accounts.find((account) => account.id === id) ?? null;
  }

  async create(input: { platform: PlatformId; label: string; startUrl?: string; loginUrl?: string; inboxUrl?: string }): Promise<Account> {
    const policy = policyFor(input.platform);
    const startUrl = input.startUrl?.trim() || policy.startUrl;
    if (!startUrl) throw new Error("start_url_required");
    const now = new Date().toISOString();
    const account: Account = {
      id: `acc_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      platform: input.platform,
      label: input.label.trim().slice(0, 120) || policy.label,
      startUrl,
      loginUrl: input.loginUrl?.trim() || policy.loginUrl || startUrl,
      inboxUrl: input.inboxUrl?.trim() || policy.inboxUrl || startUrl,
      status: "unverified",
      hasStoredSession: false,
      lastVerifiedAt: null,
      lastUsedAt: null,
      lastError: null,
      lastUrl: null,
      createdAt: now,
      updatedAt: now,
    };
    const accounts = await this.load();
    accounts.push(account);
    await this.flush();
    return account;
  }

  async update(id: string, patch: Partial<Account>): Promise<Account | null> {
    const accounts = await this.load();
    const index = accounts.findIndex((account) => account.id === id);
    if (index < 0) return null;
    accounts[index] = { ...accounts[index], ...patch, updatedAt: new Date().toISOString() };
    await this.flush();
    return accounts[index];
  }

  async remove(id: string): Promise<boolean> {
    const accounts = await this.load();
    const next = accounts.filter((account) => account.id !== id);
    if (next.length === accounts.length) return false;
    this.accounts = next;
    await this.flush();
    await writeFile(profilePath(id), "", { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
    return true;
  }

  async saveSessionState(id: string, state: unknown): Promise<void> {
    await writeEncryptedFile(profilePath(id), state);
    await this.update(id, { hasStoredSession: true });
    if (remoteStoreEnabled()) await pushRemoteState(id, state);
  }

  async loadSessionState(id: string): Promise<Record<string, unknown> | null> {
    // On an ephemeral runner the dashboard copy is the durable one, so prefer it
    // and mirror it to disk for the current job.
    if (remoteStoreEnabled()) {
      const remote = await fetchRemoteState(id);
      if (remote && typeof remote === "object") {
        await writeEncryptedFile(profilePath(id), remote).catch(() => undefined);
        await this.update(id, { hasStoredSession: true }).catch(() => undefined);
        return remote;
      }
    }
    const state = await readEncryptedFile<Record<string, unknown>>(profilePath(id));
    return state && typeof state === "object" ? state : null;
  }
}

export class AuditLog {
  async append(entry: Omit<AuditEntry, "id" | "at">): Promise<AuditEntry> {
    const record: AuditEntry = {
      id: `aud_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      at: new Date().toISOString(),
      ...entry,
      detail: entry.detail ? redact(entry.detail, 600) : undefined,
    };
    const entries = await readJson<AuditEntry[]>(auditFile(), []);
    entries.push(record);
    await writeJson(auditFile(), entries.slice(-config.auditLimit));
    return record;
  }

  async list(limit = 50): Promise<AuditEntry[]> {
    const entries = await readJson<AuditEntry[]>(auditFile(), []);
    return entries.slice(-Math.min(Math.max(limit, 1), config.auditLimit)).reverse();
  }
}

/**
 * Enforces the per-account automation budget for approved actions only.
 * Drafting (no side effect) is never rate limited.
 */
export class ActionBudget {
  async assertAllowed(accountId: string): Promise<void> {
    const budget = await readJson<ActionLedger>(budgetFile(), {});
    const stamps = (budget[accountId] ?? []).filter((stamp) => Date.now() - Date.parse(stamp) < 24 * 60 * 60_000);
    if (stamps.length >= config.actionDailyLimit) throw new Error("action_daily_limit_reached");
    const last = stamps[stamps.length - 1];
    if (last && Date.now() - Date.parse(last) < config.actionCooldownMs) throw new Error("action_cooldown_active");
    budget[accountId] = stamps;
    await writeJson(budgetFile(), budget);
  }

  async record(accountId: string): Promise<void> {
    const budget = await readJson<ActionLedger>(budgetFile(), {});
    const stamps = (budget[accountId] ?? []).filter((stamp) => Date.now() - Date.parse(stamp) < 24 * 60 * 60_000);
    stamps.push(new Date().toISOString());
    budget[accountId] = stamps;
    await writeJson(budgetFile(), budget);
  }
}

export const accounts = new AccountStore();
export const audit = new AuditLog();
export const actionBudget = new ActionBudget();
