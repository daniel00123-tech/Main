export type PaymentIntent = {
  id: string;
  providerRef: string;
  amount: number;
  status: "created" | "released" | "refunded";
  provider: string;
};

export type PaymentInput = {
  userId: string;
  amount: number;
  jobId?: string;
  metadata?: Record<string, string | number | boolean>;
};

export interface PaymentProvider {
  createPayment(input: PaymentInput): Promise<PaymentIntent>;
  releasePayment(paymentId: string): Promise<PaymentIntent>;
  refundPayment(paymentId: string): Promise<PaymentIntent>;
}

export class MockPaymentProvider implements PaymentProvider {
  async createPayment(input: PaymentInput): Promise<PaymentIntent> {
    return {
      id: `mock_${input.userId}_${Date.now()}`,
      providerRef: `mock_ref_${Date.now()}`,
      amount: input.amount,
      status: "created",
      provider: "mock",
    };
  }

  async releasePayment(paymentId: string): Promise<PaymentIntent> {
    return {
      id: paymentId,
      providerRef: paymentId,
      amount: 0,
      status: "released",
      provider: "mock",
    };
  }

  async refundPayment(paymentId: string): Promise<PaymentIntent> {
    return {
      id: paymentId,
      providerRef: paymentId,
      amount: 0,
      status: "refunded",
      provider: "mock",
    };
  }
}

export class StripePaymentProvider implements PaymentProvider {
  async createPayment(): Promise<PaymentIntent> {
    throw new Error("StripePaymentProvider is a placeholder. Wire Stripe Connect here.");
  }

  async releasePayment(): Promise<PaymentIntent> {
    throw new Error("StripePaymentProvider is a placeholder. Wire Stripe transfer release here.");
  }

  async refundPayment(): Promise<PaymentIntent> {
    throw new Error("StripePaymentProvider is a placeholder. Wire Stripe refund here.");
  }
}

export class PaymentService {
  constructor(private readonly provider: PaymentProvider) {}

  createPayment(input: PaymentInput) {
    return this.provider.createPayment(input);
  }

  releasePayment(paymentId: string) {
    return this.provider.releasePayment(paymentId);
  }

  refundPayment(paymentId: string) {
    return this.provider.refundPayment(paymentId);
  }
}
