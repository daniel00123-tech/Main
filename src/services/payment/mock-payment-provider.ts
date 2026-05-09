import { randomUUID } from "node:crypto";
import type { PaymentProvider, PaymentResult } from "@/services/payment/payment-provider";

function reference(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export class MockPaymentProvider implements PaymentProvider {
  async createPayment(): Promise<PaymentResult> {
    return {
      provider: "mock",
      providerReference: reference("mock_payment"),
      status: "COMPLETED"
    };
  }

  async releasePayment(): Promise<PaymentResult> {
    return {
      provider: "mock",
      providerReference: reference("mock_release"),
      status: "COMPLETED"
    };
  }

  async refundPayment(): Promise<PaymentResult> {
    return {
      provider: "mock",
      providerReference: reference("mock_refund"),
      status: "COMPLETED"
    };
  }
}
