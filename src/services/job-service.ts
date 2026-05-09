import {
  JobStatus,
  JobType,
  NotificationType,
  OfferStatus,
  Role,
  SupplierStatus
} from "@/generated/prisma/client";
import { marketplaceConfig } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { completionSchema, jobSchema, offerSchema } from "@/lib/validation";
import { notifyUser, notifyUsers } from "@/services/notification-service";
import {
  moveReservedToSupplierPending,
  releasePendingPayment,
  reserveFundsForJob
} from "@/services/wallet-service";

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function jsonArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export async function findMatchingSuppliers(input: { category: string; location: string }) {
  const suppliers = await prisma.supplierProfile.findMany({
    where: {
      status: SupplierStatus.APPROVED
    },
    include: {
      user: true
    }
  });

  const requestedLocation = input.location.toLowerCase();

  return suppliers.filter((supplier) => {
    const services = jsonArray(supplier.services);
    const locationMatch =
      supplier.location.toLowerCase().includes(requestedLocation) ||
      requestedLocation.includes(supplier.location.toLowerCase());

    return services.includes(input.category) && locationMatch;
  });
}

export async function createJob(customerId: string, rawInput: unknown) {
  const input = jobSchema.parse(rawInput);
  const customer = await prisma.user.findUnique({
    where: { id: customerId },
    include: { customerProfile: true }
  });

  if (!customer || customer.role !== Role.CUSTOMER || !customer.customerProfile) {
    throw new Error("Only customers can post jobs.");
  }

  const job = await prisma.job.create({
    data: {
      customerId,
      title: input.title,
      description: input.description,
      category: input.category,
      location: input.location,
      budget: input.budget,
      deadline: input.deadline,
      type: input.type,
      autoAssign: input.autoAssign
    }
  });

  const matchingSuppliers = await findMatchingSuppliers({
    category: input.category,
    location: input.location
  });

  await notifyUsers(
    matchingSuppliers.map((supplier) => ({
      userId: supplier.userId,
      type: NotificationType.JOB_MATCHED,
      title: "New matching job",
      message: `${job.title} in ${job.location} matches your services.`
    }))
  );

  await notifyUser({
    userId: customerId,
    type: NotificationType.JOB_POSTED,
    title: "Job posted",
    message: `${job.title} is now open to matching suppliers.`
  });

  return job;
}

async function assertApprovedSupplier(supplierId: string) {
  const supplier = await prisma.user.findUnique({
    where: { id: supplierId },
    include: { supplierProfile: true }
  });

  if (
    !supplier ||
    supplier.role !== Role.SUPPLIER ||
    supplier.supplierProfile?.status !== SupplierStatus.APPROVED
  ) {
    throw new Error("Supplier must be approved before accepting marketplace work.");
  }

  return supplier;
}

export async function submitOffer(supplierId: string, rawInput: unknown) {
  await assertApprovedSupplier(supplierId);
  const input = offerSchema.parse(rawInput);

  const job = await prisma.job.findUnique({ where: { id: input.jobId } });
  if (!job || job.status !== JobStatus.OPEN || job.type !== JobType.BIDDING) {
    throw new Error("Offers can only be submitted for open bidding jobs.");
  }

  const offer = await prisma.offer.create({
    data: {
      jobId: input.jobId,
      supplierId,
      price: input.price,
      message: input.message
    },
    include: {
      supplier: { include: { supplierProfile: true } },
      job: true
    }
  });

  await notifyUser({
    userId: job.customerId,
    type: NotificationType.OFFER_RECEIVED,
    title: "New supplier offer",
    message: `${offer.supplier.supplierProfile?.businessName ?? offer.supplier.email} offered £${offer.price.toString()} for ${job.title}.`
  });

  return offer;
}

export async function acceptOffer(customerId: string, offerId: string) {
  const offer = await prisma.offer.findUnique({
    where: { id: offerId },
    include: { job: true }
  });

  if (!offer || offer.job.customerId !== customerId) {
    throw new Error("Offer not found for this customer.");
  }

  if (offer.job.status !== JobStatus.OPEN || offer.status !== OfferStatus.PENDING) {
    throw new Error("Only pending offers on open jobs can be accepted.");
  }

  await reserveFundsForJob({
    customerId,
    jobId: offer.jobId,
    jobAmount: offer.price
  });

  const job = await prisma.job.update({
    where: { id: offer.jobId },
    data: {
      status: JobStatus.ASSIGNED,
      assignedSupplierId: offer.supplierId,
      budget: offer.price,
      offers: {
        update: {
          where: { id: offer.id },
          data: { status: OfferStatus.ACCEPTED }
        },
        updateMany: {
          where: {
            id: { not: offer.id },
            status: OfferStatus.PENDING
          },
          data: { status: OfferStatus.REJECTED }
        }
      }
    },
    include: {
      assignedSupplier: true
    }
  });

  await notifyUser({
    userId: offer.supplierId,
    type: NotificationType.JOB_ASSIGNED,
    title: "Offer accepted",
    message: `You have been assigned to ${job.title}.`
  });

  return job;
}

export async function acceptBroadcastJob(supplierId: string, jobId: string) {
  await assertApprovedSupplier(supplierId);
  const job = await prisma.job.findUnique({ where: { id: jobId } });

  if (!job || job.type !== JobType.BROADCAST || job.status !== JobStatus.OPEN) {
    throw new Error("Only open broadcast jobs can be accepted instantly.");
  }

  if (!job.autoAssign) {
    throw new Error("This broadcast job requires the customer to review offers.");
  }

  await reserveFundsForJob({
    customerId: job.customerId,
    jobId: job.id,
    jobAmount: job.budget
  });

  const updatedJob = await prisma.job.update({
    where: { id: job.id },
    data: {
      assignedSupplierId: supplierId,
      status: JobStatus.ASSIGNED
    }
  });

  await notifyUsers([
    {
      userId: supplierId,
      type: NotificationType.JOB_ASSIGNED,
      title: "Broadcast job assigned",
      message: `You were first to accept ${job.title}.`
    },
    {
      userId: job.customerId,
      type: NotificationType.JOB_ASSIGNED,
      title: "Broadcast job assigned",
      message: `${job.title} has been assigned to a supplier.`
    }
  ]);

  return updatedJob;
}

export async function startJob(supplierId: string, jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.assignedSupplierId !== supplierId || job.status !== JobStatus.ASSIGNED) {
    throw new Error("Assigned supplier can only start an assigned job.");
  }

  return prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.IN_PROGRESS }
  });
}

export async function markJobComplete(supplierId: string, rawInput: unknown) {
  const input = completionSchema.parse(rawInput);
  const job = await prisma.job.findUnique({ where: { id: input.jobId } });

  if (
    !job ||
    job.assignedSupplierId !== supplierId ||
    !([JobStatus.ASSIGNED, JobStatus.IN_PROGRESS] as JobStatus[]).includes(job.status)
  ) {
    throw new Error("Assigned supplier can only complete assigned or in-progress jobs.");
  }

  await moveReservedToSupplierPending({
    customerId: job.customerId,
    supplierId,
    jobId: job.id,
    jobAmount: job.budget
  });

  const updatedJob = await prisma.job.update({
    where: { id: job.id },
    data: {
      status: JobStatus.AWAITING_APPROVAL,
      completionNotes: input.notes,
      completionPhotoUrls: input.photoUrls,
      completedAt: new Date(),
      approvalDeadlineAt: addHours(new Date(), marketplaceConfig.autoReleaseHours)
    }
  });

  await notifyUser({
    userId: job.customerId,
    type: NotificationType.JOB_COMPLETED,
    title: "Job awaiting approval",
    message: `${job.title} has been marked complete. Approve or dispute before auto-release.`
  });

  return updatedJob;
}

export async function approveCompletion(customerId: string, jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });

  if (!job || job.customerId !== customerId || job.status !== JobStatus.AWAITING_APPROVAL) {
    throw new Error("Only the customer can approve a job awaiting approval.");
  }

  if (!job.assignedSupplierId) {
    throw new Error("Cannot release payment without an assigned supplier.");
  }

  await releasePendingPayment({
    customerId,
    supplierId: job.assignedSupplierId,
    jobId: job.id,
    jobAmount: job.budget
  });

  const updatedJob = await prisma.job.update({
    where: { id: job.id },
    data: {
      status: JobStatus.CLOSED,
      closedAt: new Date()
    }
  });

  await notifyUser({
    userId: job.assignedSupplierId,
    type: NotificationType.PAYMENT_RELEASED,
    title: "Payment released",
    message: `Payment for ${job.title} is now available in your wallet.`
  });

  return updatedJob;
}

export async function disputeCompletion(customerId: string, jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.customerId !== customerId || job.status !== JobStatus.AWAITING_APPROVAL) {
    throw new Error("Only the customer can dispute a job awaiting approval.");
  }

  return prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.DISPUTED }
  });
}

export async function autoReleaseExpiredJobs(now = new Date()) {
  const jobs = await prisma.job.findMany({
    where: {
      status: JobStatus.AWAITING_APPROVAL,
      approvalDeadlineAt: {
        lte: now
      },
      assignedSupplierId: {
        not: null
      }
    }
  });

  const released = [];
  for (const job of jobs) {
    released.push(await approveCompletion(job.customerId, job.id));
  }

  return released;
}
