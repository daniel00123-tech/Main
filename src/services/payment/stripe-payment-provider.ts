import type { PaymentProvider, PaymentRequest, PaymentResult } from "@/services/payment/payment-provider";

export class StripePaymentProvider implements PaymentProvider {
  async createPayment(_request: PaymentRequest): Promise<PaymentResult> {
    throw new Error("StripePaymentProvider is a placeholder for a future Stripe Connect integration.");
  }

  async releasePayment(_request: PaymentRequest): Promise<PaymentResult> {
    throw new Error("Stripe release flow is not implemented in the MVP.");
  }

  async refundPayment(_request: PaymentRequest): Promise<PaymentResult> {
    throw new Error("Stripe refund flow is not implemented in the MVP.");
  }
}
