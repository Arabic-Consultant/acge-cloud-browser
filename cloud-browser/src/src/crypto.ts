import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * AES-256-GCM secret protection identical to the dashboard format
 * ("v1.iv.tag.data", base64url-free base64). Browser session state is only
 * ever written to disk encrypted with this envelope.
 */
function encryptionKey(): Buffer {
  const raw = process.env.BROWSER_AGENT_ENCRYPTION_KEY || process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("BROWSER_AGENT_ENCRYPTION_KEY (or CREDENTIALS_ENCRYPTION_KEY) must be configured");
  }
  try {
    const key = Buffer.from(raw, "base64");
    if (key.length === 32) return key;
  } catch {
    // fall through to hashing
  }
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) throw new Error("unsupported_encrypted_payload");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export async function writeEncryptedFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, encryptSecret(JSON.stringify(value)), { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, path);
}

export async function readEncryptedFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(decryptSecret(raw.trim())) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}
