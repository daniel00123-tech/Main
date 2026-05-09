import { beforeEach, describe, expect, it } from "vitest";
import { JobStatus, SupplierStatus, TransactionType } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { feeService } from "@/services/fee-service";
import {
  acceptBroadcastJob,
  acceptOffer,
  approveCompletion,
  createJob,
  markJobComplete,
  startJob,
  submitOffer
} from "@/services/job-service";
import { addFunds, withdrawFunds } from "@/services/wallet-service";
import { registerUser, reviewSupplier } from "@/services/user-service";

async function resetDatabase() {
  await prisma.notification.deleteMany();
  await prisma.walletTransaction.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.offer.deleteMany();
  await prisma.job.deleteMany();
  await prisma.supplierProfile.deleteMany();
  await prisma.customerProfile.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.user.deleteMany();
}

async function createCustomer(email = "customer@example.com") {
  return registerUser({
    role: "CUSTOMER",
    name: "Customer User",
    email,
    phone: "07111111111",
    password: "password123",
    companyName: "Acme FM",
    location: "London"
  });
}

async function createSupplier(email = "supplier@example.com", services = ["plumbing"]) {
  const supplier = await registerUser({
    role: "SUPPLIER",
    businessName: "Supplier Ltd",
    contactName: "Supplier User",
    email,
    phone: "07222222222",
    password: "password123",
    location: "London",
    services,
    description: "Approved contractor for commercial reactive maintenance work.",
    rate: 75,
    rateType: "HOURLY",
    availability: "Weekdays"
  });

  await reviewSupplier({ supplierUserId: supplier.id, status: SupplierStatus.APPROVED });
  return supplier;
}

describe("marketplace services", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("registers customers and suppliers with wallets and pending supplier approval", async () => {
    const customer = await createCustomer();
    const supplier = await registerUser({
      role: "SUPPLIER",
      businessName: "Pending Supplier Ltd",
      contactName: "Pending User",
      email: "pending@example.com",
      phone: "07333333333",
      password: "password123",
      location: "London",
      services: ["electrical"],
      description: "Commercial electrical contractor awaiting platform review.",
      rate: 90,
      rateType: "HOURLY",
      availability: "Weekdays"
    });

    const supplierProfile = await prisma.supplierProfile.findUnique({ where: { userId: supplier.id } });

    expect(customer.wallet).toBeTruthy();
    expect(supplierProfile?.status).toBe(SupplierStatus.PENDING);
  });

  it("approves suppliers", async () => {
    const supplier = await registerUser({
      role: "SUPPLIER",
      businessName: "Review Supplier Ltd",
      contactName: "Review User",
      email: "review@example.com",
      phone: "07444444444",
      password: "password123",
      location: "London",
      services: ["plumbing"],
      description: "Commercial contractor profile for approval testing.",
      rate: 70,
      rateType: "HOURLY",
      availability: "Weekdays"
    });

    const approved = await reviewSupplier({
      supplierUserId: supplier.id,
      status: SupplierStatus.APPROVED
    });

    expect(approved.status).toBe(SupplierStatus.APPROVED);
    await expect(
      prisma.notification.findFirst({ where: { userId: supplier.id, type: "SUPPLIER_REVIEWED" } })
    ).resolves.toBeTruthy();
  });

  it("posts jobs, submits offers, assigns suppliers, and reserves wallet funds", async () => {
    const customer = await createCustomer();
    const supplier = await createSupplier();
    await addFunds(customer.id, 500);

    const job = await createJob(customer.id, {
      title: "Fix leaking pipe",
      description: "Repair a commercial kitchen pipe leak with same-day attendance.",
      category: "plumbing",
      location: "London",
      budget: 120,
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      type: "BIDDING",
      autoAssign: false
    });

    const offer = await submitOffer(supplier.id, {
      jobId: job.id,
      price: 100,
      message: "Can attend this afternoon."
    });

    const assigned = await acceptOffer(customer.id, offer.id);
    const customerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: customer.id } });

    expect(assigned.assignedSupplierId).toBe(supplier.id);
    expect(Number(customerWallet.balance)).toBe(390);
    expect(Number(customerWallet.reservedBalance)).toBe(110);
  });

  it("moves funds pending on completion and available after approval", async () => {
    const customer = await createCustomer();
    const supplier = await createSupplier();
    await addFunds(customer.id, 500);

    const job = await createJob(customer.id, {
      title: "Fix leaking pipe",
      description: "Repair a commercial kitchen pipe leak with same-day attendance.",
      category: "plumbing",
      location: "London",
      budget: 100,
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      type: "BIDDING",
      autoAssign: false
    });

    const offer = await submitOffer(supplier.id, {
      jobId: job.id,
      price: 100,
      message: "Can attend this afternoon."
    });

    await acceptOffer(customer.id, offer.id);
    await startJob(supplier.id, job.id);
    await markJobComplete(supplier.id, {
      jobId: job.id,
      notes: "Pipe repaired and tested.",
      photoUrls: ""
    });

    const pendingWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: supplier.id } });
    expect(Number(pendingWallet.pendingBalance)).toBe(99);
    expect(Number(pendingWallet.balance)).toBe(0);

    const closed = await approveCompletion(customer.id, job.id);
    const releasedWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: supplier.id } });
    const release = await prisma.transaction.findFirstOrThrow({
      where: { jobId: job.id, type: TransactionType.RELEASE }
    });

    expect(closed.status).toBe(JobStatus.CLOSED);
    expect(Number(releasedWallet.pendingBalance)).toBe(0);
    expect(Number(releasedWallet.balance)).toBe(99);
    expect(Number(release.platformFee)).toBe(11);
  });

  it("supports broadcast instant assignment for approved suppliers", async () => {
    const customer = await createCustomer();
    const supplier = await createSupplier("broadcast@example.com", ["electrical"]);
    await addFunds(customer.id, 500);

    const job = await createJob(customer.id, {
      title: "Emergency lighting test",
      description: "Carry out emergency lighting inspection before tenant handover.",
      category: "electrical",
      location: "London",
      budget: 150,
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      type: "BROADCAST",
      autoAssign: true
    });

    const assigned = await acceptBroadcastJob(supplier.id, job.id);

    expect(assigned.status).toBe(JobStatus.ASSIGNED);
    expect(assigned.assignedSupplierId).toBe(supplier.id);
  });

  it("calculates fees centrally and simulates withdrawals", async () => {
    const fees = feeService.calculate(100);
    expect(Number(fees.customerTotal)).toBe(110);
    expect(Number(fees.supplierReceives)).toBe(99);
    expect(Number(fees.platformEarns)).toBe(11);

    const supplier = await createSupplier();
    await prisma.wallet.update({
      where: { userId: supplier.id },
      data: { balance: 99 }
    });

    await withdrawFunds(supplier.id, 50);
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: supplier.id } });
    expect(Number(wallet.balance)).toBe(49);
  });
});
