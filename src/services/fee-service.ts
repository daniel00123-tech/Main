import { marketplaceConfig } from "@/lib/config";
import { roundMoney, toDecimal, type MoneyInput } from "@/lib/money";

export type FeeBreakdown = {
  jobAmount: ReturnType<typeof toDecimal>;
  customerFee: ReturnType<typeof toDecimal>;
  supplierFee: ReturnType<typeof toDecimal>;
  customerTotal: ReturnType<typeof toDecimal>;
  supplierReceives: ReturnType<typeof toDecimal>;
  platformEarns: ReturnType<typeof toDecimal>;
};

export class FeeService {
  calculate(jobAmount: MoneyInput): FeeBreakdown {
    const amount = roundMoney(jobAmount);
    const customerFee = roundMoney(amount.mul(marketplaceConfig.customerFeeRate));
    const supplierFee = roundMoney(marketplaceConfig.supplierFlatFee);
    const customerTotal = roundMoney(amount.add(customerFee));
    const supplierReceives = roundMoney(amount.sub(supplierFee));
    const platformEarns = roundMoney(customerFee.add(supplierFee));

    return {
      jobAmount: amount,
      customerFee,
      supplierFee,
      customerTotal,
      supplierReceives,
      platformEarns
    };
  }
}

export const feeService = new FeeService();
