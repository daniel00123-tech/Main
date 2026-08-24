import { describe, expect, it } from "vitest";
import { generateSalt, hashPassword, verifyPassword } from "../auth/password";

describe("password hashing", () => {
  it("hashes and verifies passwords", async () => {
    const salt = generateSalt();
    const hash = await hashPassword("correct-horse-battery", salt);
    expect(await verifyPassword("correct-horse-battery", salt, hash)).toBe(true);
    expect(await verifyPassword("wrong-password", salt, hash)).toBe(false);
  });
});
