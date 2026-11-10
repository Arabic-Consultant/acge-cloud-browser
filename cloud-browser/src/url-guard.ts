import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "./config.js";

export class UrlBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlBlockedError";
  }
}

function isPrivateV4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function isPrivateAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 4) return isPrivateV4(value);
  if (family === 6) {
    const v = value.toLowerCase();
    if (v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(v) || v.startsWith("ff") || v.startsWith("2001:db8")) return true;
    if (v.startsWith("::ffff:")) return isPrivateV4(v.slice(7).replace(/^\[|\]$/g, ""));
    return false;
  }
  return true;
}

export function hostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const hostname = host.toLowerCase().replace(/^\[|\]$/g, "");
  return allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))
    || config.extraHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

/**
 * Validates a navigation target: protocol, credentials, host allowlist and
 * (unless explicitly enabled for local verification) private address space.
 */
export async function assertNavigableUrl(raw: string, allowedHosts: readonly string[]): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlBlockedError("invalid_url");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new UrlBlockedError("unsupported_protocol");
  if (url.username || url.password) throw new UrlBlockedError("credentials_in_url");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostAllowed(host, allowedHosts)) throw new UrlBlockedError(`host_not_allowed:${host}`);
  if (config.allowPrivateHosts) return url;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UrlBlockedError("private_hostname");
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new UrlBlockedError("private_ip");
    return url;
  }
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
      throw new UrlBlockedError("host_resolves_to_private_address");
    }
  } catch (error) {
    if (error instanceof UrlBlockedError) throw error;
    throw new UrlBlockedError("host_resolution_failed");
  }
  return url;
}
