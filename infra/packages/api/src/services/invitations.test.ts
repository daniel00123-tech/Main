import { describe, expect, it } from "vitest";
import {
  acceptPendingInvitationsAfterOnboarding,
  cancelInvitation,
  listCompanyInvitations,
  normalizeInviteEmail,
  reconcileStalePendingInvitations,
  resendInvitation,
} from "./invitations";
import type { Env } from "../env";

type Row = Record<string, unknown>;

class InviteDb {
  tables = new Map<string, Row[]>();

  constructor(initial: Record<string, Row[]>) {
    for (const [name, rows] of Object.entries(initial)) {
      this.tables.set(name, rows.map((row) => ({ ...row })));
    }
  }

  prepare(sql: string) {
    return new InviteStatement(sql, this.tables);
  }
}

class InviteStatement {
  private binds: unknown[] = [];

  constructor(
    private sql: string,
    private tables: Map<string, Row[]>,
  ) {}

  bind(...values: unknown[]) {
    this.binds = values;
    return this;
  }

  private table(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  async first(): Promise<Row | null> {
    return (await this.all()).results[0] ?? null;
  }

  async all(): Promise<{ results: Row[] }> {
    return { results: this.select() };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    return { success: true, meta: { changes: this.mutate() } };
  }

  private select(): Row[] {
    const q = this.sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from user_invitations") && q.includes("where id = ? and company_id")) {
      return this.table("user_invitations").filter(
        (row) => row.id === this.binds[0] && row.company_id === this.binds[1],
      );
    }
    if (q.includes("from user_invitations") && q.includes("where id = ?")) {
      return this.table("user_invitations").filter((row) => row.id === this.binds[0]);
    }
    if (q.includes("from user_invitations i") && q.includes("inner join company_memberships")) {
      const userId = this.binds[0];
      const email = this.binds[1];
      const memberships = this.table("company_memberships").filter(
        (row) => row.user_id === userId && row.status === "active",
      );
      return this.table("user_invitations")
        .filter(
          (invite) =>
            invite.email === email &&
            ["pending", "expired"].includes(String(invite.status)) &&
            memberships.some((membership) => membership.company_id === invite.company_id),
        )
        .map((invite) => ({ id: invite.id }));
    }
    if (q.includes("from user_invitations") && q.includes("status = 'pending'")) {
      return this.table("user_invitations").filter(
        (row) => row.company_id === this.binds[0] && row.status === "pending",
      );
    }
    if (q.includes("from user_invitations") && q.includes("company_id = ?")) {
      return this.table("user_invitations")
        .filter((row) => row.company_id === this.binds[0])
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    if (q.includes("from users") && q.includes("email")) {
      const email = String(this.binds[0]).trim().toLowerCase();
      return this.table("users").filter((row) => String(row.email).toLowerCase() === email);
    }
    if (q.includes("from users") && q.includes("where id")) {
      return this.table("users").filter((row) => row.id === this.binds[0]);
    }
    if (q.includes("from company_memberships") && q.includes("status = 'active'")) {
      return this.table("company_memberships").filter(
        (row) =>
          row.user_id === this.binds[0] &&
          row.company_id === this.binds[1] &&
          row.status === "active",
      );
    }
    if (q.includes("from password_setup_tokens")) {
      return this.table("password_setup_tokens").filter(
        (row) =>
          row.user_id === this.binds[0] &&
          row.purpose === "password_setup" &&
          row.used_at,
      );
    }
    return [];
  }

  private mutate(): number {
    const q = this.sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("update user_invitations") && q.includes("status = 'accepted'")) {
      const row = this.table("user_invitations").find((item) => item.id === this.binds[2]);
      if (!row || !["pending", "expired"].includes(String(row.status))) return 0;
      row.status = "accepted";
      row.accepted_at = row.accepted_at ?? this.binds[0];
      row.updated_at = this.binds[1];
      return 1;
    }
    if (q.startsWith("update user_invitations") && q.includes("status = 'cancelled'")) {
      const row = this.table("user_invitations").find(
        (item) => item.id === this.binds[2] && item.company_id === this.binds[3] && item.status === "pending",
      );
      if (!row) return 0;
      row.status = "cancelled";
      row.cancelled_at = this.binds[0];
      row.updated_at = this.binds[1];
      return 1;
    }
    if (q.startsWith("insert into audit_events")) {
      this.table("audit_events").push({
        id: this.binds[0],
        company_id: this.binds[1],
        event_type: this.binds[2],
        actor: this.binds[3],
        resource_type: this.binds[4],
        resource_id: this.binds[5],
        detail_json: this.binds[6],
        created_at: this.binds[7],
      });
      return 1;
    }
    return 0;
  }
}

function userRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "user_william",
    email: "william@elvexpropertyservices.com",
    display_name: "William",
    password_hash: "hash",
    password_salt: "salt",
    is_platform_admin: 0,
    status: "active",
    last_login_at: "2026-09-01T17:13:09.796Z",
    created_at: "2026-08-30T13:15:42.032Z",
    updated_at: "2026-09-01T17:13:09.796Z",
    mobile_e164: "+447700900001",
    mobile_verified: 0,
    mobile_verified_at: null,
    mobile_verification_required: 0,
    ...overrides,
  };
}

function inviteRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "inv_william",
    company_id: "co_el",
    email: "william@elvexpropertyservices.com",
    display_name: "William",
    role: "office_staff",
    status: "pending",
    invited_by: "daniel.dwyer123@gmail.com",
    setup_token_id: "pst_william",
    sent_at: "2026-08-30T13:15:42.788Z",
    expires_at: "2026-09-06T13:15:42.788Z",
    cancelled_at: null,
    accepted_at: null,
    created_at: "2026-08-30T13:15:42.788Z",
    updated_at: "2026-08-30T13:15:42.788Z",
    ...overrides,
  };
}

describe("invitation lifecycle", () => {
  it("normalizes invite email case", () => {
    expect(normalizeInviteEmail("  William@ElvexPropertyServices.com ")).toBe(
      "william@elvexpropertyservices.com",
    );
  });

  it("accepts a pending invite after onboarding", async () => {
    const db = new InviteDb({
      users: [userRow()],
      company_memberships: [
        {
          id: "membership_william",
          user_id: "user_william",
          company_id: "co_el",
          role: "office_staff",
          status: "active",
        },
      ],
      user_invitations: [inviteRow()],
      password_setup_tokens: [
        {
          id: "pst_william",
          user_id: "user_william",
          purpose: "password_setup",
          used_at: "2026-08-30T13:18:49.908Z",
        },
      ],
      audit_events: [],
    });

    const accepted = await acceptPendingInvitationsAfterOnboarding(
      db as unknown as D1Database,
      "user_william",
    );
    expect(accepted).toEqual(["inv_william"]);
    expect(db.tables.get("user_invitations")?.[0]?.status).toBe("accepted");
    expect(db.tables.get("user_invitations")?.[0]?.accepted_at).toBeTruthy();
    expect(db.tables.get("audit_events")?.some((row) => row.event_type === "invitation.accepted")).toBe(
      true,
    );
  });

  it("does not show an accepted invite as pending", async () => {
    const db = new InviteDb({
      users: [userRow()],
      company_memberships: [
        {
          id: "membership_william",
          user_id: "user_william",
          company_id: "co_el",
          role: "office_staff",
          status: "active",
        },
      ],
      user_invitations: [inviteRow({ status: "accepted", accepted_at: "2026-08-30T13:18:49.908Z" })],
      password_setup_tokens: [],
      audit_events: [],
    });
    const listed = await listCompanyInvitations(db as unknown as D1Database, "co_el");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("accepted");
    expect(listed[0]?.acceptedAt).toBe("2026-08-30T13:18:49.908Z");
  });

  it("reconciles a stale pending invite only with onboarding evidence", async () => {
    const db = new InviteDb({
      users: [userRow()],
      company_memberships: [
        {
          id: "membership_william",
          user_id: "user_william",
          company_id: "co_el",
          role: "office_staff",
          status: "active",
        },
      ],
      user_invitations: [inviteRow()],
      password_setup_tokens: [
        {
          id: "pst_william",
          user_id: "user_william",
          purpose: "password_setup",
          used_at: "2026-08-30T13:18:49.908Z",
        },
      ],
      audit_events: [],
    });
    const reconciled = await reconcileStalePendingInvitations(db as unknown as D1Database, "co_el");
    expect(reconciled).toEqual(["inv_william"]);
    expect(db.tables.get("user_invitations")?.[0]?.status).toBe("accepted");
    expect(db.tables.get("audit_events")?.some((row) => row.event_type === "invitation.reconciled")).toBe(
      true,
    );
  });

  it("does not auto-accept an unused invite just because a user row exists", async () => {
    const db = new InviteDb({
      users: [
        userRow({
          id: "user_sharon",
          email: "sharon@elvexpropertyservices.com",
          display_name: "Sharon",
          last_login_at: null,
        }),
      ],
      company_memberships: [
        {
          id: "membership_sharon",
          user_id: "user_sharon",
          company_id: "co_el",
          role: "office_staff",
          status: "active",
        },
      ],
      user_invitations: [
        inviteRow({
          id: "inv_sharon",
          email: "sharon@elvexpropertyservices.com",
          display_name: "Sharon",
          setup_token_id: "pst_sharon",
        }),
      ],
      password_setup_tokens: [
        { id: "pst_sharon", user_id: "user_sharon", purpose: "password_setup", used_at: null },
      ],
      audit_events: [],
    });
    const reconciled = await reconcileStalePendingInvitations(db as unknown as D1Database, "co_el");
    expect(reconciled).toEqual([]);
    expect(db.tables.get("user_invitations")?.[0]?.status).toBe("pending");
  });

  it("does not auto-accept an unrelated active user", async () => {
    const db = new InviteDb({
      users: [userRow({ id: "user_other", email: "other@example.com", last_login_at: "2026-09-01T00:00:00Z" })],
      company_memberships: [
        {
          id: "membership_other",
          user_id: "user_other",
          company_id: "co_el",
          role: "office_staff",
          status: "active",
        },
      ],
      user_invitations: [inviteRow()],
      password_setup_tokens: [],
      audit_events: [],
    });
    const reconciled = await reconcileStalePendingInvitations(db as unknown as D1Database, "co_el");
    expect(reconciled).toEqual([]);
    expect(db.tables.get("user_invitations")?.[0]?.status).toBe("pending");
  });

  it("matches invite email case-insensitively", async () => {
    const db = new InviteDb({
      users: [userRow({ email: "William@elvexpropertyservices.com" })],
      company_memberships: [
        {
          id: "membership_william",
          user_id: "user_william",
          company_id: "co_el",
          role: "office_staff",
          status: "active",
        },
      ],
      user_invitations: [inviteRow({ email: "william@elvexpropertyservices.com" })],
      password_setup_tokens: [
        { id: "pst_william", user_id: "user_william", purpose: "password_setup", used_at: "t" },
      ],
      audit_events: [],
    });
    const reconciled = await reconcileStalePendingInvitations(db as unknown as D1Database, "co_el");
    expect(reconciled).toEqual(["inv_william"]);
  });

  it("rejects cancel and resend of an accepted invitation", async () => {
    const db = new InviteDb({
      users: [userRow()],
      user_invitations: [inviteRow({ status: "accepted", accepted_at: "2026-08-30T13:18:49.908Z" })],
      company_memberships: [],
      password_setup_tokens: [],
      audit_events: [],
    });
    await expect(cancelInvitation(db as unknown as D1Database, "co_el", "inv_william")).rejects.toThrow(
      /already been accepted/,
    );
    await expect(
      resendInvitation(
        { DB: db as unknown as D1Database } as Env,
        {
          companyId: "co_el",
          companyName: "EL Business",
          invitationId: "inv_william",
          inviterName: "Daniel",
          origin: "https://app.infrastack.app",
        },
      ),
    ).rejects.toThrow(/already been accepted/);
    expect(db.tables.get("user_invitations")?.[0]?.status).toBe("accepted");
  });

  it("rejects cancel of a cancelled invite and keeps membership separate", async () => {
    const db = new InviteDb({
      users: [userRow()],
      user_invitations: [inviteRow({ status: "cancelled", cancelled_at: "2026-09-01T00:00:00Z" })],
      company_memberships: [
        {
          id: "membership_william",
          user_id: "user_william",
          company_id: "co_el",
          role: "office_staff",
          status: "active",
        },
      ],
      password_setup_tokens: [],
      audit_events: [],
    });
    await expect(cancelInvitation(db as unknown as D1Database, "co_el", "inv_william")).rejects.toThrow(
      /Only pending/,
    );
    expect(db.tables.get("company_memberships")?.[0]?.status).toBe("active");
  });

  it("treats expired pending invites as expired in the list", async () => {
    const db = new InviteDb({
      users: [],
      company_memberships: [],
      password_setup_tokens: [],
      audit_events: [],
      user_invitations: [
        inviteRow({
          id: "inv_old",
          email: "old@example.com",
          expires_at: "2020-01-01T00:00:00.000Z",
        }),
      ],
    });
    const listed = await listCompanyInvitations(db as unknown as D1Database, "co_el");
    expect(listed[0]?.status).toBe("expired");
  });
});
