import type { MoneyInput } from "@/lib/money";

export type PaymentRequest = {
  jobId?: string;
  payerId?: string;
  payeeId?: string;
  amount: MoneyInput;
  description: string;
};

export type PaymentResult = {
  provider: string;
  providerReference: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
};

export interface PaymentProvider {
  createPayment(request: PaymentRequest): Promise<PaymentResult>;
  releasePayment(request: PaymentRequest): Promise<PaymentResult>;
  refundPayment(request: PaymentRequest): Promise<PaymentResult>;
}
