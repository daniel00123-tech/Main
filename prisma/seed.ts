import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { calculateMarketplaceFees } from "../src/services/fee-service";
import { JOB_STATUS, JOB_TYPE, NOTIFICATION_TYPE, OFFER_STATUS, ROLE, SUPPLIER_STATUS, TRANSACTION_STATUS, TRANSACTION_TYPE, WALLET_TRANSACTION_TYPE } from "../src/lib/types";

const prisma = new PrismaClient();

async function main() {
  await prisma.notification.deleteMany();
  await prisma.walletTransaction.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.offer.deleteMany();
  await prisma.job.deleteMany();
  await prisma.supplierProfile.deleteMany();
  await prisma.customerProfile.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.user.deleteMany();

  const passwordHash = await bcrypt.hash("Password123!", 12);

  const admin = await prisma.user.create({
    data: {
      email: "admin@example.com",
      name: "Marketplace Admin",
      role: ROLE.ADMIN,
      passwordHash,
      wallet: { create: {} },
    },
  });

  const [customerA, customerB] = await Promise.all([
    prisma.user.create({
      data: {
        email: "fm.customer@example.com",
        name: "Alex Morgan",
        phone: "020 7000 1000",
        role: ROLE.CUSTOMER,
        passwordHash,
        wallet: { create: { balance: 500000 } },
        customerProfile: { create: { companyName: "Northstar FM", location: "London" } },
      },
    }),
    prisma.user.create({
      data: {
        email: "ops.customer@example.com",
        name: "Priya Shah",
        phone: "020 7000 2000",
        role: ROLE.CUSTOMER,
        passwordHash,
        wallet: { create: { balance: 300000 } },
        customerProfile: { create: { companyName: "Metro Facilities", location: "Manchester" } },
      },
    }),
  ]);

  const suppliers = await Promise.all([
    prisma.user.create({
      data: {
        email: "plumbing.supplier@example.com",
        name: "Jamie Reed",
        phone: "07111 111111",
        role: ROLE.SUPPLIER,
        passwordHash,
        wallet: { create: {} },
        supplierProfile: {
          create: {
            businessName: "Reed Reactive Plumbing",
            contactName: "Jamie Reed",
            location: "London",
            services: JSON.stringify(["plumbing", "hvac"]),
            description: "Emergency plumbing and planned maintenance for commercial sites.",
            rateType: "hourly",
            rateAmount: 6500,
            availability: "Weekdays and emergency weekends",
            status: SUPPLIER_STATUS.APPROVED,
          },
        },
      },
    }),
    prisma.user.create({
      data: {
        email: "electrical.supplier@example.com",
        name: "Sam Taylor",
        phone: "07222 222222",
        role: ROLE.SUPPLIER,
        passwordHash,
        wallet: { create: {} },
        supplierProfile: {
          create: {
            businessName: "Taylor Electrical Ltd",
            contactName: "Sam Taylor",
            location: "London",
            services: JSON.stringify(["electrical", "security"]),
            description: "NICEIC-approved commercial electrical contractor.",
            rateType: "fixed",
            rateAmount: 15000,
            availability: "Mon-Sat",
            status: SUPPLIER_STATUS.APPROVED,
          },
        },
      },
    }),
    prisma.user.create({
      data: {
        email: "cleaning.supplier@example.com",
        name: "Morgan Lee",
        phone: "07333 333333",
        role: ROLE.SUPPLIER,
        passwordHash,
        wallet: { create: {} },
        supplierProfile: {
          create: {
            businessName: "Lee Commercial Cleaning",
            contactName: "Morgan Lee",
            location: "Manchester",
            services: JSON.stringify(["cleaning", "general"]),
            description: "Specialist commercial cleaning team awaiting onboarding checks.",
            rateType: "hourly",
            rateAmount: 3500,
            availability: "Evenings",
            status: SUPPLIER_STATUS.PENDING,
          },
        },
      },
    }),
  ]);

  const jobs = await Promise.all([
    prisma.job.create({
      data: {
        customerId: customerA.id,
        title: "Urgent washroom leak repair",
        description: "Leak under basin in third-floor washroom causing water ingress.",
        category: "plumbing",
        location: "London",
        budget: 10000,
        deadline: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        jobType: JOB_TYPE.BROADCAST,
        firstSupplierCanAccept: true,
      },
    }),
    prisma.job.create({
      data: {
        customerId: customerA.id,
        title: "Replace faulty corridor lighting",
        description: "Three LED panels intermittently failing in customer-facing area.",
        category: "electrical",
        location: "London",
        budget: 22000,
        deadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        jobType: JOB_TYPE.BIDDING,
      },
    }),
    prisma.job.create({
      data: {
        customerId: customerB.id,
        title: "Out of hours office deep clean",
        description: "Post-refurbishment clean over two floors.",
        category: "cleaning",
        location: "Manchester",
        budget: 45000,
        deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        jobType: JOB_TYPE.BIDDING,
      },
    }),
    prisma.job.create({
      data: {
        customerId: customerA.id,
        title: "Boiler pressure investigation",
        description: "Investigate pressure drops on commercial boiler loop.",
        category: "hvac",
        location: "London",
        budget: 18000,
        deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        jobType: JOB_TYPE.BROADCAST,
        firstSupplierCanAccept: false,
      },
    }),
    prisma.job.create({
      data: {
        customerId: customerA.id,
        supplierId: suppliers[0].id,
        title: "Completed tap replacement",
        description: "Replace sensor tap in reception washroom.",
        category: "plumbing",
        location: "London",
        budget: 10000,
        deadline: new Date(Date.now() - 24 * 60 * 60 * 1000),
        jobType: JOB_TYPE.BIDDING,
        status: JOB_STATUS.CLOSED,
        completionNotes: "Tap replaced and tested.",
        completionPhotoUrls: JSON.stringify(["https://example.com/tap-before.jpg", "https://example.com/tap-after.jpg"]),
        completedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
        closedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    }),
  ]);

  const acceptedOffer = await prisma.offer.create({
    data: {
      jobId: jobs[4].id,
      supplierId: suppliers[0].id,
      price: 10000,
      message: "Can complete today with stocked parts.",
      status: OFFER_STATUS.ACCEPTED,
    },
  });

  await prisma.job.update({ where: { id: jobs[4].id }, data: { acceptedOfferId: acceptedOffer.id } });

  await prisma.offer.createMany({
    data: [
      { jobId: jobs[1].id, supplierId: suppliers[1].id, price: 21000, message: "Can attend Wednesday morning." },
      { jobId: jobs[3].id, supplierId: suppliers[0].id, price: 17500, message: "Can investigate and quote remedial works." },
    ],
  });

  const fees = calculateMarketplaceFees(10000);
  const supplierWallet = await prisma.wallet.update({
    where: { userId: suppliers[0].id },
    data: { balance: { increment: fees.supplierReceives } },
  });

  await prisma.transaction.createMany({
    data: [
      {
        userId: customerA.id,
        jobId: jobs[4].id,
        type: TRANSACTION_TYPE.PLATFORM_FEE,
        status: TRANSACTION_STATUS.SUCCEEDED,
        amount: fees.platformFeeTotal,
        feeAmount: fees.platformFeeTotal,
        provider: "mock",
      },
      {
        userId: suppliers[0].id,
        jobId: jobs[4].id,
        type: TRANSACTION_TYPE.JOB_RELEASE,
        status: TRANSACTION_STATUS.SUCCEEDED,
        amount: fees.supplierReceives,
        provider: "mock",
      },
    ],
  });

  await prisma.walletTransaction.create({
    data: {
      userId: suppliers[0].id,
      walletId: supplierWallet.id,
      type: WALLET_TRANSACTION_TYPE.RELEASE,
      amount: fees.supplierReceives,
      balanceAfter: supplierWallet.balance,
      pendingAfter: supplierWallet.pendingBalance,
      reservedAfter: supplierWallet.reservedBalance,
      description: "Seeded completed job payment release",
      relatedJobId: jobs[4].id,
    },
  });

  await prisma.notification.createMany({
    data: [
      { userId: admin.id, type: NOTIFICATION_TYPE.SUPPLIER_APPROVED, title: "Seed data ready", message: "Demo marketplace data has been loaded." },
      { userId: suppliers[0].id, type: NOTIFICATION_TYPE.JOB_MATCHED, title: "New matching job", message: "Urgent washroom leak repair matches your services.", metadata: JSON.stringify({ jobId: jobs[0].id }) },
      { userId: customerA.id, type: NOTIFICATION_TYPE.OFFER_RECEIVED, title: "Offer received", message: "A supplier submitted an offer for Boiler pressure investigation.", metadata: JSON.stringify({ jobId: jobs[3].id }) },
    ],
  });

  console.log("Seed complete. Demo password for all users: Password123!");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
