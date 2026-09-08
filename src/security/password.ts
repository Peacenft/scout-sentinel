import { timingSafeEqual } from "node:crypto";

const ALGORITHM = "pbkdf2-sha256";
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 32;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const saltBuffer = Uint8Array.from(salt).buffer;
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations },
    material,
    DERIVED_KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derive(password, salt, ITERATIONS);
  return `$${ALGORITHM}$${ITERATIONS}$${Buffer.from(salt).toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  const match = /^\$pbkdf2-sha256\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(storedHash);
  if (!match) return false;
  const iterations = Number(match[1]);
  if (!Number.isSafeInteger(iterations) || iterations < ITERATIONS || iterations > 2_000_000) return false;

  const salt = Buffer.from(match[2] ?? "", "base64url");
  const expected = Buffer.from(match[3] ?? "", "base64url");
  if (salt.length < SALT_BYTES || expected.length !== DERIVED_KEY_BYTES) return false;

  const actual = Buffer.from(await derive(password, salt, iterations));
  return timingSafeEqual(actual, expected);
}
