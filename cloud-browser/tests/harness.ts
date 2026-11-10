import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type RuntimeHandle = {
  url: string;
  token: string;
  dataDir: string;
  stop: () => Promise<void>;
};

const ROOT = resolve(import.meta.dirname, "..");

export async function makeDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "acge-browser-"));
}

export async function startRuntime(options: { dataDir: string; extraEnv?: Record<string, string> }): Promise<RuntimeHandle> {
  const token = randomBytes(24).toString("hex");
  const env = {
    ...process.env,
    NODE_ENV: "development",
    BROWSER_AGENT_PORT: "0",
    BROWSER_AGENT_HOST: "127.0.0.1",
    BROWSER_AGENT_TOKEN: token,
    BROWSER_AGENT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    BROWSER_AGENT_DATA_DIR: options.dataDir,
    BROWSER_AGENT_ALLOW_PRIVATE_HOSTS: "1",
    BROWSER_AGENT_EXTRA_HOSTS: "127.0.0.1,localhost",
    BROWSER_AGENT_HEADLESS: "1",
    BROWSER_AGENT_MAX_STEPS: "6",
    ...options.extraEnv,
  };

  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const url = await new Promise<string>((resolveUrl, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`runtime_start_timeout: ${buffer.slice(-800)}`)), 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as { status?: string; port?: number };
          if (parsed.status === "listening" && parsed.port) {
            clearTimeout(timer);
            resolveUrl(`http://127.0.0.1:${parsed.port}`);
          }
        } catch {
          // partial line
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`runtime_exited:${code}: ${buffer.slice(-800)}`));
    });
  });

  return { url, token, dataDir: options.dataDir, stop: () => stopChild(child) };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveStop) => {
    child.once("exit", () => resolveStop());
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 8000).unref();
  });
}

export class RuntimeClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async request<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(120_000),
    });
    const data = (await response.json().catch(() => ({}))) as T;
    return { status: response.status, data };
  }

  async streamEvents(path: string, onEvent: (event: Record<string, unknown>) => void, stopWhen: () => boolean): Promise<void> {
    const controller = new AbortController();
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`stream_failed_${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!stopWhen()) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const payload = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          if (!payload) continue;
          try {
            onEvent(JSON.parse(payload) as Record<string, unknown>);
          } catch {
            // ignore partial json
          }
        }
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  }
}

export async function waitFor<T>(check: () => Promise<T | null>, timeoutMs = 60_000, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error("wait_for_timeout");
}
