import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/security/crypto.js";

describe("credential encryption", () => {
  it("binds ciphertext to its workspace context and rejects tampering", () => {
    const key = randomBytes(32).toString("base64");
    const plaintext = JSON.stringify({ access_token: "provider-secret", token_type: "Bearer" });
    const ciphertext = encryptSecret(plaintext, key, "unused-fallback", "binance-connection:user-a");

    expect(ciphertext).not.toContain("provider-secret");
    expect(decryptSecret(ciphertext, key, "unused-fallback", "binance-connection:user-a")).toBe(plaintext);
    expect(() => decryptSecret(ciphertext, key, "unused-fallback", "binance-connection:user-b")).toThrow();

    const parts = ciphertext.split(".");
    const encryptedPayload = parts[3] ?? "";
    parts[3] = `${encryptedPayload.startsWith("A") ? "B" : "A"}${encryptedPayload.slice(1)}`;
    const tampered = parts.join(".");
    expect(() => decryptSecret(tampered, key, "unused-fallback", "binance-connection:user-a")).toThrow();
  });
});
