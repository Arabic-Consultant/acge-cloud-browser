import { gzipSync, gunzipSync } from "node:zlib";
import { config } from "./config.js";

/**
 * Durable session storage for ephemeral runners (GitHub Actions).
 * The runner keeps its normal on-disk profile; when APP_URL is configured the
 * encrypted state is also pushed to the dashboard so the next job can restore a
 * login that was created in a previous job.
 */
export function remoteStoreEnabled(): boolean {
  return config.remoteStore && Boolean(config.appUrl) && config.token.length >= 24;
}

function url(accountId: string): string {
  return `${config.appUrl}/api/browser/session-store/${encodeURIComponent(accountId)}`;
}

export async function fetchRemoteState(accountId: string): Promise<Record<string, unknown> | null> {
  if (!remoteStoreEnabled()) return null;
  try {
    const response = await fetch(url(accountId), {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as { payload?: string | null } | null;
    if (!data?.payload) return null;
    return JSON.parse(gunzipSync(Buffer.from(data.payload, "base64")).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function pushRemoteState(accountId: string, state: unknown): Promise<boolean> {
  if (!remoteStoreEnabled()) return false;
  try {
    const payload = gzipSync(Buffer.from(JSON.stringify(state), "utf8"), { level: 9 }).toString("base64");
    const response = await fetch(url(accountId), {
      method: "PUT",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ payload }),
      signal: AbortSignal.timeout(20_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
