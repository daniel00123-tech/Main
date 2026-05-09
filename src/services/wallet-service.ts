import { TransactionType, WalletTransactionType } from "@/generated/prisma/client";
import { roundMoney, toDecimal, type MoneyInput } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { feeService } from "@/services/fee-service";
import { paymentService } from "@/services/payment/payment-service";

async function getWalletOrThrow(userId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) {
    throw new Error("Wallet not found.");
  }

  return wallet;
}

export async function ensureWallet(userId: string) {
  return prisma.wallet.upsert({
    where: { userId },
    create: { userId },
    update: {}
  });
}

export async function addFunds(userId: string, amountInput: MoneyInput) {
  const amount = roundMoney(amountInput);
  const wallet = await ensureWallet(userId);

  const transaction = await paymentService.createPayment({
    payerId: userId,
    amount,
    description: "Simulated wallet top-up",
    type: TransactionType.DEPOSIT
  });

  await prisma.wallet.update({
    where: { id: wallet.id },
    data: {
      balance: wallet.balance.add(amount),
      transactions: {
        create: {
          type: WalletTransactionType.DEPOSIT,
          amount,
          description: "Simulated customer wallet top-up",
          transactionId: transaction.id
        }
      }
    }
  });

  return transaction;
}

export async function reserveFundsForJob(input: {
  customerId: string;
  jobId: string;
  jobAmount: MoneyInput;
}) {
  const fees = feeService.calculate(input.jobAmount);
  const wallet = await getWalletOrThrow(input.customerId);

  if (wallet.balance.lt(fees.customerTotal)) {
    throw new Error("Insufficient customer wallet balance.");
  }

  const transaction = await paymentService.createPayment({
    jobId: input.jobId,
    payerId: input.customerId,
    amount: fees.customerTotal,
    description: "Funds reserved for assigned marketplace job",
    type: TransactionType.JOB_PAYMENT,
    platformFee: fees.platformEarns,
    supplierFee: fees.supplierFee
  });

  await prisma.wallet.update({
    where: { id: wallet.id },
    data: {
      balance: wallet.balance.sub(fees.customerTotal),
      reservedBalance: wallet.reservedBalance.add(fees.customerTotal),
      transactions: {
        create: {
          jobId: input.jobId,
          transactionId: transaction.id,
          type: WalletTransactionType.RESERVE,
          amount: fees.customerTotal,
          description: "Reserved job amount plus customer marketplace fee"
        }
      }
    }
  });

  return { fees, transaction };
}

export async function moveReservedToSupplierPending(input: {
  customerId: string;
  supplierId: string;
  jobId: string;
  jobAmount: MoneyInput;
}) {
  const fees = feeService.calculate(input.jobAmount);
  const customerWallet = await getWalletOrThrow(input.customerId);
  const supplierWallet = await ensureWallet(input.supplierId);

  if (customerWallet.reservedBalance.lt(fees.customerTotal)) {
    throw new Error("Reserved customer funds are not available.");
  }

  await prisma.wallet.update({
    where: { id: customerWallet.id },
    data: {
      reservedBalance: customerWallet.reservedBalance.sub(fees.customerTotal),
      transactions: {
        create: [
          {
            jobId: input.jobId,
            type: WalletTransactionType.PLATFORM_FEE,
            amount: fees.customerFee,
            description: "Customer marketplace fee retained by platform"
          },
          {
            jobId: input.jobId,
            type: WalletTransactionType.SUPPLIER_FEE,
            amount: fees.supplierFee,
            description: "Supplier flat marketplace fee retained by platform"
          }
        ]
      }
    }
  });

  await prisma.wallet.update({
    where: { id: supplierWallet.id },
    data: {
      pendingBalance: supplierWallet.pendingBalance.add(fees.supplierReceives),
      transactions: {
        create: {
          jobId: input.jobId,
          type: WalletTransactionType.RELEASE_TO_SUPPLIER,
          amount: fees.supplierReceives,
          description: "Funds pending customer approval window"
        }
      }
    }
  });

  return fees;
}

export async function releasePendingPayment(input: {
  customerId: string;
  supplierId: string;
  jobId: string;
  jobAmount: MoneyInput;
}) {
  const existingRelease = await prisma.transaction.findFirst({
    where: {
      jobId: input.jobId,
      type: TransactionType.RELEASE
    }
  });

  if (existingRelease) {
    return existingRelease;
  }

  const fees = feeService.calculate(input.jobAmount);
  const supplierWallet = await getWalletOrThrow(input.supplierId);

  if (supplierWallet.pendingBalance.lt(fees.supplierReceives)) {
    throw new Error("Pending supplier funds are not available.");
  }

  const transaction = await paymentService.releasePayment({
    jobId: input.jobId,
    payerId: input.customerId,
    payeeId: input.supplierId,
    amount: toDecimal(input.jobAmount),
    description: "Released marketplace job payment",
    platformFee: fees.platformEarns,
    supplierFee: fees.supplierFee
  });

  await prisma.wallet.update({
    where: { id: supplierWallet.id },
    data: {
      pendingBalance: supplierWallet.pendingBalance.sub(fees.supplierReceives),
      balance: supplierWallet.balance.add(fees.supplierReceives),
      transactions: {
        create: {
          jobId: input.jobId,
          transactionId: transaction.id,
          type: WalletTransactionType.RELEASE_TO_SUPPLIER,
          amount: fees.supplierReceives,
          description: "Released to supplier available balance"
        }
      }
    }
  });

  return transaction;
}

export async function withdrawFunds(userId: string, amountInput: MoneyInput) {
  const amount = roundMoney(amountInput);
  const wallet = await getWalletOrThrow(userId);

  if (wallet.balance.lt(amount)) {
    throw new Error("Insufficient available balance.");
  }

  const transaction = await paymentService.createPayment({
    payeeId: userId,
    amount,
    description: "Simulated supplier withdrawal",
    type: TransactionType.WITHDRAWAL
  });

  await prisma.wallet.update({
    where: { id: wallet.id },
    data: {
      balance: wallet.balance.sub(amount),
      transactions: {
        create: {
          transactionId: transaction.id,
          type: WalletTransactionType.WITHDRAWAL,
          amount,
          description: "Simulated withdrawal to supplier bank account"
        }
      }
    }
  });

  return transaction;
}
