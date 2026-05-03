import { marketplaceConfig } from "@/lib/config";

export type FeeBreakdown = {
  jobAmount: number;
  customerFee: number;
  supplierFee: number;
  customerTotal: number;
  supplierReceives: number;
  platformFeeTotal: number;
};

export class FeeService {
  constructor(
    private readonly customerFeeRate = marketplaceConfig.customerFeeRate,
    private readonly supplierFlatFee = marketplaceConfig.supplierFlatFeePence,
  ) {}

  calculate(jobAmount: number): FeeBreakdown {
    if (!Number.isInteger(jobAmount) || jobAmount <= 0) {
      throw new Error("Job amount must be a positive integer in minor currency units.");
    }

    const customerFee = Math.round(jobAmount * this.customerFeeRate);
    const supplierFee = this.supplierFlatFee;
    const supplierReceives = Math.max(jobAmount - supplierFee, 0);

    return {
      jobAmount,
      customerFee,
      supplierFee,
      customerTotal: jobAmount + customerFee,
      supplierReceives,
      platformFeeTotal: customerFee + supplierFee,
    };
  }
}

export const feeService = new FeeService();
export const calculateMarketplaceFees = (jobAmount: number) => feeService.calculate(jobAmount);
