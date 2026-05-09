import type { PaymentProvider, PaymentResult } from "@/services/payment/payment-provider";

export class StripePaymentProvider implements PaymentProvider {
  async createPayment(): Promise<PaymentResult> {
    throw new Error("StripePaymentProvider is a placeholder for a future Stripe Connect integration.");
  }

  async releasePayment(): Promise<PaymentResult> {
    throw new Error("Stripe release flow is not implemented in the MVP.");
  }

  async refundPayment(): Promise<PaymentResult> {
    throw new Error("Stripe refund flow is not implemented in the MVP.");
  }
}
