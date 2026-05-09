import type { PaymentProvider, PaymentRequest, PaymentResult } from "@/services/payment/payment-provider";

function reference(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export class MockPaymentProvider implements PaymentProvider {
  async createPayment(_request: PaymentRequest): Promise<PaymentResult> {
    return {
      provider: "mock",
      providerReference: reference("mock_payment"),
      status: "COMPLETED"
    };
  }

  async releasePayment(_request: PaymentRequest): Promise<PaymentResult> {
    return {
      provider: "mock",
      providerReference: reference("mock_release"),
      status: "COMPLETED"
    };
  }

  async refundPayment(_request: PaymentRequest): Promise<PaymentResult> {
    return {
      provider: "mock",
      providerReference: reference("mock_refund"),
      status: "COMPLETED"
    };
  }
}
