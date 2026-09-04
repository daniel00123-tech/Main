/**
 * Current INFRA TEST charging treatment.
 *
 * Do not change production wallet amounts from this file.
 * MCP usage must emit usage_records when it passes through the INFRA gateway;
 * wallet debit still follows decideTestBilling + pricing rules.
 */
export type BillableTreatment = {
  event: string;
  recordsUsage: boolean;
  walletDebit: boolean;
  notes: string;
};

export const BILLABLE_EVENT_MATRIX: BillableTreatment[] = [
  {
    event: "mcp.initialize",
    recordsUsage: false,
    walletDebit: false,
    notes: "Protocol handshake — not a customer operation",
  },
  {
    event: "mcp.tools/list",
    recordsUsage: false,
    walletDebit: false,
    notes: "Tool discovery is not billable",
  },
  {
    event: "mcp.health / system.health",
    recordsUsage: true,
    walletDebit: false,
    notes: "Recorded for health/usage visibility; TEST policy is non-billable",
  },
  {
    event: "knowledge.search / knowledge.read success",
    recordsUsage: true,
    walletDebit: true,
    notes: "TEST: 1p when a pricing rule marks the action billable",
  },
  {
    event: "Microsoft Graph / Outlook search/read via gateway",
    recordsUsage: true,
    walletDebit: false,
    notes: "Usage row yes; no pricing rule → zero_charge (do not start charging)",
  },
  {
    event: "Xero read/report via gateway",
    recordsUsage: true,
    walletDebit: false,
    notes: "Usage row yes; no customer debit unless a pricing rule exists",
  },
  {
    event: "write preview (dry-run)",
    recordsUsage: true,
    walletDebit: false,
    notes: "Preview is metered as a request; not a financial execution charge",
  },
  {
    event: "executed write",
    recordsUsage: true,
    walletDebit: true,
    notes: "Only if a billable pricing rule exists for that write action",
  },
  {
    event: "automation",
    recordsUsage: true,
    walletDebit: true,
    notes: "Follows automation metering + existing pricing",
  },
  {
    event: "failed downstream request",
    recordsUsage: true,
    walletDebit: false,
    notes: "success=0; TEST does not debit on failure",
  },
  {
    event: "permission-denied request",
    recordsUsage: true,
    walletDebit: false,
    notes: "Must appear on Usage as denied / non-billable",
  },
  {
    event: "EL customer.request (co_el only)",
    recordsUsage: true,
    walletDebit: true,
    notes: "Prospective EL commercial tariff: 3p per genuine user turn. Child tools do not debit.",
  },
  {
    event: "admin verification / AI connection test",
    recordsUsage: true,
    walletDebit: false,
    notes: "system_health probe — non-billable",
  },
  {
    event: "direct company MCP (bypassing INFRA gateway)",
    recordsUsage: false,
    walletDebit: false,
    notes: "GAP: not metered. Human ChatGPT must use INFRA OAuth + gateway",
  },
];
