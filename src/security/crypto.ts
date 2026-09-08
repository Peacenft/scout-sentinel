import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function tokenHash(token: string, pepper: string): string {
  return createHmac("sha256", pepper).update(token).digest("hex");
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeValue(nested)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

export function documentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function encryptionKey(configuredKey: string | undefined, fallbackSecret: string): Buffer {
  if (configuredKey) {
    const key = Buffer.from(configuredKey, "base64");
    if (key.length !== 32) throw new Error("BINANCE_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
    return key;
  }
  return createHash("sha256").update(`scout-sentinel:development-token-key:${fallbackSecret}`).digest();
}

export function encryptSecret(value: string, configuredKey: string | undefined, fallbackSecret: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(configuredKey, fallbackSecret), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(value: string, configuredKey: string | undefined, fallbackSecret: string, context: string): string {
  const [version, ivValue, tagValue, ciphertextValue, extra] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || ciphertextValue === undefined || extra !== undefined) {
    throw new Error("Encrypted secret has an unsupported format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(configuredKey, fallbackSecret), Buffer.from(ivValue, "base64url"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
}
