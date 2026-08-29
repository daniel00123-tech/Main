import { describe, expect, it } from "vitest";
import { createUser, inviteCompanyUser, setUserMobileE164 } from "./users";
import { MobileCollisionError, MobileValidationError } from "../services/phone";

type Row = Record<string, unknown>;

function mockDb(existing: Row[] = []) {
  const users = [...existing];
  return {
    users,
    db: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes("WHERE email")) {
                  return users.find((row) => row.email === values[0]) ?? null;
                }
                if (sql.includes("WHERE mobile_e164")) {
                  return users.find((row) => row.mobile_e164 === values[0]) ?? null;
                }
                if (sql.includes("WHERE id")) {
                  return users.find((row) => row.id === values[0]) ?? null;
                }
                if (sql.includes("FROM company_memberships")) {
                  return null;
                }
                return users[users.length - 1] ?? null;
              },
              async run() {
                if (sql.includes("UPDATE users") && sql.includes("mobile_e164")) {
                  const target = users.find((row) => row.id === values[2]);
                  if (target) {
                    target.mobile_e164 = values[0];
                    target.mobile_verified = 0;
                    target.mobile_verified_at = null;
                    target.mobile_verification_required = 0;
                    target.updated_at = values[1];
                  }
                  return { success: true };
                }
                if (sql.includes("INSERT INTO users")) {
                  users.push({
                    id: values[0],
                    email: values[1],
                    display_name: values[2],
                    password_hash: values[3],
                    password_salt: values[4],
                    is_platform_admin: values[5],
                    status: "active",
                    last_login_at: null,
                    created_at: values[6],
                    updated_at: values[7],
                    mobile_e164: values[8],
                    mobile_verified: 0,
                    mobile_verified_at: null,
                    mobile_verification_required: values[9],
                  });
                }
                return { success: true };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  };
}

describe("user mobile identity", () => {
  it("requires E.164 mobile for new invited users", async () => {
    const { db } = mockDb();
    await expect(
      inviteCompanyUser(db, {
        email: "new@example.com",
        displayName: "New User",
        companyId: "co_1",
        role: "office_staff",
      }),
    ).rejects.toBeInstanceOf(MobileValidationError);
  });

  it("rejects duplicate mobiles", async () => {
    const { db } = mockDb([
      {
        id: "user_existing",
        email: "old@example.com",
        display_name: "Old",
        password_hash: "x",
        password_salt: "y",
        is_platform_admin: 0,
        status: "active",
        last_login_at: null,
        created_at: "t",
        updated_at: "t",
        mobile_e164: "+447700900123",
        mobile_verified: 0,
        mobile_verification_required: 0,
      },
    ]);
    await expect(
      createUser(db, {
        email: "new@example.com",
        displayName: "New",
        password: "Password123!",
        requireMobile: true,
        mobile: "+447700900123",
      }),
    ).rejects.toBeInstanceOf(MobileCollisionError);
  });

  it("keeps existing users without a mobile usable and flagged", async () => {
    const { db, users } = mockDb();
    const user = await createUser(db, {
      email: "legacy@example.com",
      displayName: "Legacy",
      password: "Password123!",
    });
    expect(user.mobileE164).toBeNull();
    expect(user.mobileVerificationRequired).toBe(true);
    expect(user.status).toBe("active");
    expect(users[0]?.mobile_verification_required).toBe(1);
  });

  it("attaches an E.164 mobile to an existing user", async () => {
    const { db } = mockDb();
    const user = await createUser(db, {
      email: "legacy@example.com",
      displayName: "Legacy",
      password: "Password123!",
    });
    const updated = await setUserMobileE164(db, user.id, "07700900123");
    expect(updated.mobileE164).toBe("+447700900123");
    expect(updated.mobileVerificationRequired).toBe(false);
  });
});
