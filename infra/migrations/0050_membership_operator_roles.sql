-- Portal/operator intended membership role. Acceptance probes may temporarily
-- change company_memberships.role (e.g. office_staff denial) but must restore
-- this intended role. William is intended Director — never leave him office_staff.
CREATE TABLE IF NOT EXISTS membership_operator_roles (
  membership_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  intended_role TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_membership_operator_roles_user
  ON membership_operator_roles(user_id, company_id);

INSERT OR REPLACE INTO membership_operator_roles (
  membership_id, company_id, user_id, intended_role, set_by, set_at
) VALUES (
  'membership_78495c59-cff6-4db5-9986-a351ebe154f1',
  'co_el',
  'user_b0db1fc5-692c-436d-99e6-392966b20df8',
  'director',
  'operator-override',
  datetime('now')
);
