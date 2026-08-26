# Roles, Read/Write Commands & Permissions

## Core principle

Every MCP tool call — read or write — passes through INFRA for:
1. **Permission check** (user role)
2. **Credit check** (prepaid balance)
3. **Metering** (usage event + ledger debit)
4. **Audit log**

Enforced **server-side**. ChatGPT, Claude, WhatsApp, and automations all use the same rules.

---

## Preset company roles

| Role | Slug | Typical user |
| --- | --- | --- |
| Engineer | `engineer` | Field engineer (John) |
| Junior Office | `junior_office` | Junior admin |
| Office Staff | `office_staff` | Office coordinator (Sarah) |
| Supervisor | `supervisor` | Team lead |
| Manager | `manager` | Department manager (Mike) |
| Director | `director` | Company director |
| Company Admin | `company_admin` | Owner (Charlie) |

Defined in code: `infra/packages/shared/src/permissions/role-presets.ts`

---

## Read examples

| User says | Tool | Role required |
| --- | --- | --- |
| "When is engineer 7 booked?" | `bigchange.engineers.schedule.read` | Engineer+ |
| "Find January 2026 invoices" | `bigchange.invoices.read` | Junior Office+ |
| "Search knowledge for SOP on gas jobs" | `knowledge.search` | Engineer+ |
| "What's the parent contact for job 4521?" | `bigchange.customers.read` + glossary | Office Staff+ |

---

## Write examples

| User says | Tool | Role required | Risk |
| --- | --- | --- | --- |
| "Book engineer 7 tomorrow 9am" | `bigchange.jobs.book_engineer` | Office Staff+ | WRITE |
| "Create a new job for ABC Ltd" | `bigchange.jobs.create` | Office Staff+ | WRITE |
| "Raise PO for £250 materials" | `bigchange.purchase_orders.create` | Office Staff+ | WRITE |
| "Raise invoice for £100" | `bigchange.invoices.create` | Supervisor+ | FINANCIAL |
| "Send quote to customer" | `commusoft.quotes.send` | Manager+ | EXTERNAL_SEND |
| "Delete invoice SI-123" | `bigchange.invoices.delete` | Director | DELETE |

---

## Denied example

```
John (Engineer): "Book engineer 7 into a job"
→ INFRA: DENY (engineer cannot book jobs)
→ ChatGPT: "You don't have permission. Ask office staff."
→ Audit: permission.denied (no charge)
```

---

## Company definitions + permissions together

When user says "I meant sales not invoices":
1. **Definition** updated: `revenue = invoices - credit_notes` (Section 22 in design doc)
2. **Permission** still checked on the re-run query
3. Both apply on every future request

---

## Assigning roles (company portal)

Charlie (Company Admin) in EL portal → Team → Invite user:
- John Smith → Engineer
- Sarah Jones → Office Staff
- Mike Brown → Manager

Same INFRA backend whether user accesses via ChatGPT or company portal.

---

## Automations

Automations use a **service identity** (not a human user):
- e.g. `automation:ht-send-quotes-daily`
- Granted specific permissions when you wire it in Cursor
- Same metering and audit as human requests

See `03-ARCHITECTURE-DESIGN.md` Section 23 for full worked examples.
