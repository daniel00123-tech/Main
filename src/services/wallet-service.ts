import { Prisma } from "@prisma/client";
import { TRANSACTION_STATUS, TRANSACTION_TYPE, WALLET_TRANSACTION_TYPE, type WalletTransactionType } from "@/lib/types";
import { MockPaymentProvider, type PaymentProvider } from "./payment-provider";

type TxClient = Prisma.TransactionClient;

type WalletMutationInput = {
  userId: string;
  amount: number;
  description: string;
  relatedJobId?: string;
  relatedOfferId?: string;
};

export class WalletService {
  constructor(
    private readonly db: TxClient,
    private readonly paymentProvider: PaymentProvider = new MockPaymentProvider(),
  ) {}

  async ensureWallet(userId: string) {
    return this.db.wallet.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  }

  async addFunds(input: WalletMutationInput) {
    const payment = await this.paymentProvider?.createPayment({
      amount: input.amount,
      userId: input.userId,
      metadata: { reason: "wallet_top_up" },
    });
    const wallet = await this.ensureWallet(input.userId);
    const updated = await this.db.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: input.amount } },
    });
    await this.record(input.userId, updated.id, WALLET_TRANSACTION_TYPE.CREDIT, input.amount, updated, input.description, input.relatedJobId);
    await this.db.transaction.create({
      data: {
        userId: input.userId,
        type: TRANSACTION_TYPE.CUSTOMER_FUNDING,
        status: TRANSACTION_STATUS.SUCCEEDED,
        amount: input.amount,
        provider: payment?.provider ?? "mock",
        providerRef: payment?.providerRef ?? `mock_funding_${Date.now()}`,
      },
    });
    return updated;
  }

  async reserveFunds(input: WalletMutationInput) {
    const wallet = await this.ensureWallet(input.userId);
    if (wallet.balance < input.amount) {
      throw new Error("Insufficient wallet balance");
    }
    const updated = await this.db.wallet.update({
      where: { id: wallet.id },
      data: {
        balance: { decrement: input.amount },
        reservedBalance: { increment: input.amount },
      },
    });
    await this.record(input.userId, updated.id, WALLET_TRANSACTION_TYPE.HOLD, input.amount, updated, input.description, input.relatedJobId, input.relatedOfferId);
    return updated;
  }

  async moveReservedToSupplierPending(input: {
    customerId: string;
    supplierId: string;
    reservedAmount: number;
    supplierPendingAmount: number;
    platformFeeAmount: number;
    jobId: string;
  }) {
    const customerWallet = await this.ensureWallet(input.customerId);
    if (customerWallet.reservedBalance < input.reservedAmount) {
      throw new Error("Reserved balance is lower than release amount");
    }

    const updatedCustomer = await this.db.wallet.update({
      where: { id: customerWallet.id },
      data: { reservedBalance: { decrement: input.reservedAmount } },
    });
    await this.record(
      input.customerId,
      updatedCustomer.id,
      WALLET_TRANSACTION_TYPE.RELEASE,
      input.reservedAmount,
      updatedCustomer,
      "Released reserved customer payment",
      input.jobId,
    );

    const supplierWallet = await this.ensureWallet(input.supplierId);
    const updatedSupplier = await this.db.wallet.update({
      where: { id: supplierWallet.id },
      data: { pendingBalance: { increment: input.supplierPendingAmount } },
    });
    await this.record(
      input.supplierId,
      updatedSupplier.id,
      WALLET_TRANSACTION_TYPE.CREDIT,
      input.supplierPendingAmount,
      updatedSupplier,
      "Moved job proceeds to pending supplier balance",
      input.jobId,
    );

    await this.db.transaction.createMany({
      data: [
        {
          userId: input.supplierId,
          jobId: input.jobId,
          type: TRANSACTION_TYPE.JOB_RELEASE,
          status: TRANSACTION_STATUS.PENDING,
          amount: input.supplierPendingAmount,
          provider: "mock",
          metadata: JSON.stringify({ stage: "supplier_pending" }),
        },
        {
          userId: input.customerId,
          jobId: input.jobId,
          type: TRANSACTION_TYPE.PLATFORM_FEE,
          status: TRANSACTION_STATUS.SUCCEEDED,
          amount: input.platformFeeAmount,
          feeAmount: input.platformFeeAmount,
          provider: "mock",
          metadata: JSON.stringify({ stage: "platform_fee" }),
        },
      ],
    });

    return updatedSupplier;
  }

  async releaseSupplierPending(input: WalletMutationInput) {
    const wallet = await this.ensureWallet(input.userId);
    if (wallet.pendingBalance < input.amount) {
      throw new Error("Pending balance is lower than release amount");
    }
    const updated = await this.db.wallet.update({
      where: { id: wallet.id },
      data: {
        pendingBalance: { decrement: input.amount },
        balance: { increment: input.amount },
      },
    });
    await this.record(input.userId, updated.id, WALLET_TRANSACTION_TYPE.RELEASE, input.amount, updated, input.description, input.relatedJobId);
    await this.db.transaction.updateMany({
      where: {
        userId: input.userId,
        jobId: input.relatedJobId,
        type: TRANSACTION_TYPE.JOB_RELEASE,
        status: TRANSACTION_STATUS.PENDING,
      },
      data: { status: TRANSACTION_STATUS.SUCCEEDED },
    });
    return updated;
  }

  async withdraw(input: WalletMutationInput) {
    const payment = await this.paymentProvider?.releasePayment(`withdrawal_${input.userId}_${Date.now()}`);
    const wallet = await this.ensureWallet(input.userId);
    if (wallet.balance < input.amount) {
      throw new Error("Insufficient wallet balance");
    }
    const updated = await this.db.wallet.update({
      where: { id: wallet.id },
      data: { balance: { decrement: input.amount } },
    });
    await this.record(input.userId, updated.id, WALLET_TRANSACTION_TYPE.WITHDRAWAL, input.amount, updated, input.description);
    await this.db.transaction.create({
      data: {
        userId: input.userId,
        type: TRANSACTION_TYPE.SUPPLIER_WITHDRAWAL,
        status: TRANSACTION_STATUS.SUCCEEDED,
        amount: input.amount,
        provider: payment?.provider ?? "mock",
        providerRef: payment?.providerRef,
      },
    });
    return updated;
  }

  private async record(
    userId: string,
    walletId: string,
    type: WalletTransactionType,
    amount: number,
    wallet: { balance: number; pendingBalance: number; reservedBalance: number },
    description: string,
    relatedJobId?: string,
    relatedOfferId?: string,
  ) {
    return this.db.walletTransaction.create({
      data: {
        userId,
        walletId,
        type,
        amount,
        balanceAfter: wallet.balance,
        pendingAfter: wallet.pendingBalance,
        reservedAfter: wallet.reservedBalance,
        description,
        relatedJobId,
        relatedOfferId,
      },
    });
  }
}
