import { JobStatus, SupplierStatus } from "../generated/prisma/client";
import { prisma } from "../src/lib/prisma";
import { approveCompletion, createJob, markJobComplete, startJob, submitOffer, acceptOffer } from "../src/services/job-service";
import { addFunds } from "../src/services/wallet-service";
import { createAdminUser, registerUser, reviewSupplier } from "../src/services/user-service";

async function reset() {
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

async function main() {
  await reset();

  await createAdminUser({
    name: "Admin User",
    email: "admin@example.com",
    password: "password123",
    phone: "07000000000"
  });

  const customerOne = await registerUser({
    role: "CUSTOMER",
    name: "Sarah Mills",
    email: "customer1@example.com",
    phone: "07111111111",
    password: "password123",
    companyName: "Northstar FM",
    location: "London"
  });

  const customerTwo = await registerUser({
    role: "CUSTOMER",
    name: "James Patel",
    email: "customer2@example.com",
    phone: "07222222222",
    password: "password123",
    companyName: "Metro Facilities",
    location: "Manchester"
  });

  const supplierOne = await registerUser({
    role: "SUPPLIER",
    businessName: "Prime Plumbing Ltd",
    contactName: "Amelia Cole",
    email: "supplier1@example.com",
    phone: "07333333333",
    password: "password123",
    location: "London",
    services: ["plumbing", "general-maintenance"],
    description: "Commercial plumbing team with same-day reactive maintenance coverage.",
    rate: 65,
    rateType: "HOURLY",
    availability: "Weekdays and emergency callouts"
  });

  const supplierTwo = await registerUser({
    role: "SUPPLIER",
    businessName: "VoltPro Electrical",
    contactName: "Noah Reed",
    email: "supplier2@example.com",
    phone: "07444444444",
    password: "password123",
    location: "London",
    services: ["electrical", "security"],
    description: "Approved electricians for retail, office, and industrial facilities.",
    rate: 80,
    rateType: "HOURLY",
    availability: "Monday to Saturday"
  });

  const supplierThree = await registerUser({
    role: "SUPPLIER",
    businessName: "CleanFlow Services",
    contactName: "Maya Green",
    email: "supplier3@example.com",
    phone: "07555555555",
    password: "password123",
    location: "Manchester",
    services: ["cleaning", "hvac"],
    description: "Cleaning and air quality maintenance for commercial buildings.",
    rate: 120,
    rateType: "FIXED",
    availability: "Pending onboarding"
  });

  await reviewSupplier({ supplierUserId: supplierOne.id, status: SupplierStatus.APPROVED });
  await reviewSupplier({ supplierUserId: supplierTwo.id, status: SupplierStatus.APPROVED });

  await addFunds(customerOne.id, 1000);
  await addFunds(customerTwo.id, 800);

  const jobs = await Promise.all([
    createJob(customerOne.id, {
      title: "Repair leaking office kitchen pipe",
      description: "Kitchen pipe leak affecting shared office facilities, requires urgent repair.",
      category: "plumbing",
      location: "London",
      budget: 100,
      deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      type: "BIDDING",
      autoAssign: false
    }),
    createJob(customerOne.id, {
      title: "Broadcast emergency lighting inspection",
      description: "Inspect emergency lighting and provide compliance notes before tenant handover.",
      category: "electrical",
      location: "London",
      budget: 250,
      deadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      type: "BROADCAST",
      autoAssign: true
    }),
    createJob(customerTwo.id, {
      title: "Manchester office deep clean",
      description: "Deep clean required after refurbishment works on two floors of commercial office.",
      category: "cleaning",
      location: "Manchester",
      budget: 450,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      type: "BIDDING",
      autoAssign: false
    }),
    createJob(customerOne.id, {
      title: "Door access reader fault",
      description: "Investigate intermittent access reader failures at reception and loading bay.",
      category: "security",
      location: "London",
      budget: 180,
      deadline: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000),
      type: "BIDDING",
      autoAssign: false
    }),
    createJob(customerTwo.id, {
      title: "HVAC filter replacement",
      description: "Replace HVAC filters in plant room and confirm airflow readings after service.",
      category: "hvac",
      location: "Manchester",
      budget: 320,
      deadline: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      type: "BROADCAST",
      autoAssign: true
    })
  ]);

  const completedOffer = await submitOffer(supplierOne.id, {
    jobId: jobs[0].id,
    price: 100,
    message: "Can attend today with replacement parts included."
  });

  await submitOffer(supplierTwo.id, {
    jobId: jobs[3].id,
    price: 175,
    message: "Can inspect tomorrow and provide replacement recommendation."
  });

  await acceptOffer(customerOne.id, completedOffer.id);
  await startJob(supplierOne.id, jobs[0].id);
  await markJobComplete(supplierOne.id, {
    jobId: jobs[0].id,
    notes: "Leak fixed and kitchen tested under load.",
    photoUrls: "https://example.com/photos/leak-fixed.jpg"
  });
  await approveCompletion(customerOne.id, jobs[0].id);

  await prisma.job.update({
    where: { id: jobs[2].id },
    data: { status: JobStatus.OPEN }
  });

  console.log("Seeded marketplace MVP data.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
