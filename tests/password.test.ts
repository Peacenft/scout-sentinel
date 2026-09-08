import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/security/password.js";

describe("password hashing", () => {
  it("uses a unique salt and verifies only the correct password", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");

    expect(first).not.toBe(second);
    expect(first).toMatch(/^\$pbkdf2-sha256\$600000\$/);
    await expect(verifyPassword(first, "correct horse battery staple")).resolves.toBe(true);
    await expect(verifyPassword(first, "wrong password")).resolves.toBe(false);
    await expect(verifyPassword("malformed", "correct horse battery staple")).resolves.toBe(false);
  });
});
