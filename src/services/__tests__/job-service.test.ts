import { describe, expect, it, vi } from "vitest";
import { JOB_STATUS, JOB_TYPE, OFFER_STATUS, ROLE, SUPPLIER_STATUS, TRANSACTION_STATUS, TRANSACTION_TYPE } from "@/lib/types";
import { JobService } from "@/services/job-service";

function createDb() {
  const state = {
    wallets: new Map<string, { id: string; userId: string; balance: number; pendingBalance: number; reservedBalance: number }>(),
    jobs: new Map<string, any>(),
    offers: new Map<string, any>(),
    users: new Map<string, any>(),
    transactions: [] as any[],
    walletTransactions: [] as any[],
  };

  state.users.set("supplier_1", { id: "supplier_1", role: ROLE.SUPPLIER, supplierProfile: { status: SUPPLIER_STATUS.APPROVED } });
  state.users.set("customer_1", { id: "customer_1", role: ROLE.CUSTOMER });
  state.wallets.set("customer_1", { id: "wallet_customer", userId: "customer_1", balance: 20000, pendingBalance: 0, reservedBalance: 0 });

  const db = {
    user: {
      findUnique: vi.fn(async ({ where }: any) => state.users.get(where.id) ?? null),
    },
    supplierProfile: {
      findMany: vi.fn(async () => []),
    },
    notification: {
      create: vi.fn(async ({ data }: any) => data),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    wallet: {
      upsert: vi.fn(async ({ where, create }: any) => {
        let wallet = state.wallets.get(where.userId);
        if (!wallet) {
          wallet = { id: `wallet_${where.userId}`, userId: create.userId, balance: 0, pendingBalance: 0, reservedBalance: 0 };
          state.wallets.set(where.userId, wallet);
        }
        return { ...wallet };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const wallet = [...state.wallets.values()].find((item) => item.id === where.id);
        if (!wallet) throw new Error("wallet missing");
        for (const key of ["balance", "pendingBalance", "reservedBalance"] as const) {
          if (data[key]?.increment) wallet[key] += data[key].increment;
          if (data[key]?.decrement) wallet[key] -= data[key].decrement;
        }
        return { ...wallet };
      }),
    },
    walletTransaction: {
      create: vi.fn(async ({ data }: any) => {
        state.walletTransactions.push(data);
        return data;
      }),
    },
    transaction: {
      create: vi.fn(async ({ data }: any) => {
        state.transactions.push(data);
        return data;
      }),
      createMany: vi.fn(async ({ data }: any) => {
        state.transactions.push(...data);
        return { count: data.length };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        state.transactions.forEach((transaction) => {
          if (transaction.userId === where.userId && transaction.jobId === where.jobId && transaction.type === where.type) {
            transaction.status = data.status;
          }
        });
        return { count: 1 };
      }),
    },
    job: {
      create: vi.fn(async ({ data }: any) => {
        const job = { id: "job_1", status: JOB_STATUS.OPEN, ...data };
        state.jobs.set(job.id, job);
        return job;
      }),
      findUnique: vi.fn(async ({ where, include }: any) => {
        const job = state.jobs.get(where.id);
        if (!job) return null;
        if (include?.acceptedOffer) return { ...job, acceptedOffer: state.offers.get(job.acceptedOfferId) };
        return { ...job };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const job = state.jobs.get(where.id);
        Object.assign(job, data);
        return { ...job };
      }),
      findMany: vi.fn(async () => []),
    },
    offer: {
      create: vi.fn(async ({ data }: any) => {
        const offer = { id: "offer_1", status: OFFER_STATUS.PENDING, ...data };
        state.offers.set(offer.id, offer);
        return offer;
      }),
      findUnique: vi.fn(async ({ where, include }: any) => {
        const offer = state.offers.get(where.id);
        if (!offer) return null;
        if (include?.job) return { ...offer, job: state.jobs.get(offer.jobId) };
        return { ...offer };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const offer = state.offers.get(where.id);
        Object.assign(offer, data);
        return { ...offer };
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(),
    },
  };

  return { state, db: db as any };
}

describe("JobService workflows", () => {
  it("creates jobs and submits offers from approved suppliers", async () => {
    const { state, db } = createDb();
    const service = new JobService(db);

    await service.createJob({
      customerId: "customer_1",
      title: "Leak repair",
      description: "Repair a leak in plant room",
      category: "plumbing",
      location: "London",
      budget: 10000,
      deadline: new Date(Date.now() + 86400000),
      jobType: JOB_TYPE.BIDDING,
      firstSupplierCanAccept: false,
    });
    const offer = await service.submitOffer({ jobId: "job_1", supplierId: "supplier_1", price: 10000, message: "Can attend today" });

    expect(state.jobs.get("job_1").status).toBe(JOB_STATUS.OPEN);
    expect(offer.status).toBe(OFFER_STATUS.PENDING);
  });

  it("assigns, completes, and releases a job through wallet balances", async () => {
    const { state, db } = createDb();
    const service = new JobService(db);
    await service.createJob({
      customerId: "customer_1",
      title: "Leak repair",
      description: "Repair a leak in plant room",
      category: "plumbing",
      location: "London",
      budget: 10000,
      deadline: new Date(Date.now() + 86400000),
      jobType: JOB_TYPE.BIDDING,
      firstSupplierCanAccept: false,
    });
    await service.submitOffer({ jobId: "job_1", supplierId: "supplier_1", price: 10000, message: "Can attend today" });

    await service.assignOffer({ customerId: "customer_1", offerId: "offer_1" });
    expect(state.wallets.get("customer_1")?.reservedBalance).toBe(11000);
    expect(state.jobs.get("job_1").status).toBe(JOB_STATUS.ASSIGNED);

    await service.submitCompletion({ supplierId: "supplier_1", jobId: "job_1", notes: "Completed", photoUrls: [] });
    expect(state.wallets.get("supplier_1")?.pendingBalance).toBe(9900);
    expect(state.transactions).toContainEqual(expect.objectContaining({ type: TRANSACTION_TYPE.PLATFORM_FEE, amount: 1100 }));

    await service.approveCompletion({ customerId: "customer_1", jobId: "job_1" });
    expect(state.wallets.get("supplier_1")?.balance).toBe(9900);
    expect(state.transactions).toContainEqual(expect.objectContaining({ type: TRANSACTION_TYPE.JOB_RELEASE, status: TRANSACTION_STATUS.SUCCEEDED }));
    expect(state.jobs.get("job_1").status).toBe(JOB_STATUS.CLOSED);
  });
});
