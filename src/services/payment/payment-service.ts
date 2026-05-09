import { TransactionStatus, TransactionType } from "@/generated/prisma/client";
import { toDecimal, type MoneyInput } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/config";
import { MockPaymentProvider } from "@/services/payment/mock-payment-provider";
import type { PaymentProvider } from "@/services/payment/payment-provider";
import { StripePaymentProvider } from "@/services/payment/stripe-payment-provider";

export class PaymentService {
  constructor(private readonly provider: PaymentProvider) {}

  async createPayment(input: {
    jobId?: string;
    payerId?: string;
    payeeId?: string;
    amount: MoneyInput;
    description: string;
    type?: TransactionType;
    platformFee?: MoneyInput;
    supplierFee?: MoneyInput;
  }) {
    const result = await this.provider.createPayment(input);

    return prisma.transaction.create({
      data: {
        jobId: input.jobId,
        payerId: input.payerId,
        payeeId: input.payeeId,
        amount: toDecimal(input.amount),
        type: input.type ?? TransactionType.JOB_PAYMENT,
        status: result.status as TransactionStatus,
        provider: result.provider,
        providerReference: result.providerReference,
        platformFee: input.platformFee ? toDecimal(input.platformFee) : undefined,
        supplierFee: input.supplierFee ? toDecimal(input.supplierFee) : undefined,
        metadata: { description: input.description }
      }
    });
  }

  async releasePayment(input: {
    jobId: string;
    payerId: string;
    payeeId: string;
    amount: MoneyInput;
    description: string;
    platformFee: MoneyInput;
    supplierFee: MoneyInput;
  }) {
    const result = await this.provider.releasePayment(input);

    return prisma.transaction.create({
      data: {
        jobId: input.jobId,
        payerId: input.payerId,
        payeeId: input.payeeId,
        amount: toDecimal(input.amount),
        type: TransactionType.RELEASE,
        status: result.status as TransactionStatus,
        provider: result.provider,
        providerReference: result.providerReference,
        platformFee: toDecimal(input.platformFee),
        supplierFee: toDecimal(input.supplierFee),
        metadata: { description: input.description }
      }
    });
  }

  async refundPayment(input: {
    jobId?: string;
    payerId?: string;
    payeeId?: string;
    amount: MoneyInput;
    description: string;
  }) {
    const result = await this.provider.refundPayment(input);

    return prisma.transaction.create({
      data: {
        jobId: input.jobId,
        payerId: input.payerId,
        payeeId: input.payeeId,
        amount: toDecimal(input.amount),
        type: TransactionType.REFUND,
        status: result.status as TransactionStatus,
        provider: result.provider,
        providerReference: result.providerReference,
        metadata: { description: input.description }
      }
    });
  }
}

function getPaymentProvider(): PaymentProvider {
  if (env.PAYMENT_PROVIDER === "stripe") {
    return new StripePaymentProvider();
  }

  return new MockPaymentProvider();
}

export const paymentService = new PaymentService(getPaymentProvider());
