import { newId } from "../db/mappers";
import { appendLedgerEntry, getWalletBalance } from "./ledger";
import {
  EL_COMPANY_ID,
  EL_CUSTOMER_REQUEST_PRICE_CENTS,
  ensureElCustomerPricing,
  recordElChildUsage,
  settleElCustomerRequest,
} from "./el-customer-billing";

export async function runElBillingCampaign(db: D1Database, input?: { reverse?: boolean }) {
  const policy = await ensureElCustomerPricing(db);
  const before = await getWalletBalance(db, EL_COMPANY_ID);
  const batchId = newId("elbill");

  const ten = [];
  for (let i = 0; i < 10; i += 1) {
    const requestId = `${batchId}_ten_${i}`;
    const settled = await settleElCustomerRequest(db, {
      companyId: EL_COMPANY_ID,
      requestId,
      sourceClient: i < 5 ? "portal_chat" : "whatsapp",
      actorEmail: "system:el-billing-suite",
      trafficClass: "CUSTOMER_REQUEST",
      outcome: "completed",
      summary: `EL billing suite 10-request #${i + 1}`,
      metadata: { suite: "el_3p", batchId },
    });
    await recordElChildUsage(db, {
      companyId: EL_COMPANY_ID,
      parentRequestId: requestId,
      sourceClient: i < 5 ? "portal_chat" : "whatsapp",
      toolName: "xero_sales_summary",
      action: "xero.sales.summary",
      requestId: `${requestId}_child`,
      metadata: { suite: "el_3p" },
    });
    ten.push(settled);
  }

  const afterTen = await getWalletBalance(db, EL_COMPANY_ID);
  const tenDebit = before.balanceCents - afterTen.balanceCents;

  const channels = [
    ...Array.from({ length: 5 }, () => "portal_chat" as const),
    ...Array.from({ length: 5 }, () => "whatsapp" as const),
    ...Array.from({ length: 5 }, () => "chatgpt" as const),
  ];
  const cross = [];
  for (const [index, sourceClient] of channels.entries()) {
    cross.push(
      await settleElCustomerRequest(db, {
        companyId: EL_COMPANY_ID,
        requestId: `${batchId}_cross_${index}`,
        sourceClient,
        actorEmail: "system:el-billing-suite",
        trafficClass: "CUSTOMER_REQUEST",
        outcome: "completed",
        summary: `EL billing suite cross-channel #${index + 1}`,
        metadata: { suite: "el_3p", batchId },
      }),
    );
  }
  const afterCross = await getWalletBalance(db, EL_COMPANY_ID);
  const crossDebit = afterTen.balanceCents - afterCross.balanceCents;
  const totalDebit = before.balanceCents - afterCross.balanceCents;

  const nonChargeable = [];
  for (const trafficClass of ["TEST", "SHADOW", "QUALITY", "INTERNAL", "AUTOMATION", "HEALTH"] as const) {
    nonChargeable.push(
      await settleElCustomerRequest(db, {
        companyId: EL_COMPANY_ID,
        requestId: `${batchId}_${trafficClass.toLowerCase()}`,
        sourceClient: "whatsapp",
        trafficClass,
        actorEmail: "system:el-billing-suite",
      }),
    );
  }
  const afterInternal = await getWalletBalance(db, EL_COMPANY_ID);

  let reversed = false;
  if (input?.reverse !== false && totalDebit > 0) {
    await appendLedgerEntry(db, {
      companyId: EL_COMPANY_ID,
      entryType: "manual_credit",
      amountCents: totalDebit,
      referenceType: "el_billing_suite_reversal",
      referenceId: batchId,
      description: "EL 3p billing suite reversal — test debit returned",
      createdBy: "system:el-billing-suite",
      metadata: { suite: "el_3p", batchId, reversedCents: totalDebit },
    });
    reversed = true;
  }
  const after = await getWalletBalance(db, EL_COMPANY_ID);

  return {
    policy,
    batchId,
    priceCents: EL_CUSTOMER_REQUEST_PRICE_CENTS,
    wallet: {
      beforeCents: before.balanceCents,
      afterTenCents: afterTen.balanceCents,
      afterCrossCents: afterCross.balanceCents,
      afterInternalCents: afterInternal.balanceCents,
      afterCents: after.balanceCents,
      tenDebitCents: tenDebit,
      crossDebitCents: crossDebit,
      totalDebitCents: totalDebit,
      reversed,
    },
    tenRequest: {
      expectedCents: 30,
      actualCents: tenDebit,
      charged: ten.filter((row) => row.charged).length,
      alreadySettled: ten.filter((row) => row.alreadySettled).length,
    },
    crossChannel: {
      expectedCents: 45,
      actualCents: crossDebit,
      charged: cross.filter((row) => row.charged).length,
    },
    nonChargeable: {
      charged: nonChargeable.filter((row) => row.charged).length,
      walletMoved: afterInternal.balanceCents !== afterCross.balanceCents,
    },
  };
}
