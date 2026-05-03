import { Prisma } from "@prisma/client";
import { appConfig } from "@/lib/config";
import { JOB_STATUS, JOB_TYPE, NOTIFICATION_TYPE, OFFER_STATUS, ROLE, SUPPLIER_STATUS } from "@/lib/types";
import { calculateMarketplaceFees } from "@/services/fee-service";
import { NotificationService } from "@/services/notification-service";
import { WalletService } from "@/services/wallet-service";

type TxClient = Prisma.TransactionClient;

export class JobService {
  constructor(private readonly db: TxClient) {}

  async createJob(input: {
    customerId: string;
    title: string;
    description: string;
    category: string;
    location: string;
    budget: number;
    deadline: Date;
    jobType: string;
    firstSupplierCanAccept: boolean;
  }) {
    const job = await this.db.job.create({
      data: {
        customerId: input.customerId,
        title: input.title,
        description: input.description,
        category: input.category,
        location: input.location,
        budget: input.budget,
        deadline: input.deadline,
        jobType: input.jobType,
        firstSupplierCanAccept: input.firstSupplierCanAccept,
      },
    });

    const notifications = new NotificationService(this.db);
    await notifications.create({
      userId: input.customerId,
      type: NOTIFICATION_TYPE.JOB_POSTED,
      title: "Job posted",
      message: `${job.title} is now live.`,
      metadata: { jobId: job.id },
    });

    if (input.jobType === JOB_TYPE.BROADCAST) {
      const suppliers = await this.findMatchingSuppliers(input.category, input.location);
      await Promise.all(
        suppliers.map((supplier) =>
          notifications.create({
            userId: supplier.userId,
            type: NOTIFICATION_TYPE.JOB_MATCHED,
            title: "New matching job",
            message: `${job.title} matches your services.`,
            metadata: {
              jobId: job.id,
              category: input.category,
            },
          }),
        ),
      );
    }

    return job;
  }

  async submitOffer(input: { jobId: string; supplierId: string; price: number; message: string }) {
    await this.assertApprovedSupplier(input.supplierId);
    const job = await this.db.job.findUnique({ where: { id: input.jobId } });
    if (!job || job.status !== JOB_STATUS.OPEN) {
      throw new Error("Job is not open for offers");
    }

    const offer = await this.db.offer.create({
      data: {
        jobId: input.jobId,
        supplierId: input.supplierId,
        price: input.price,
        message: input.message,
      },
    });

    await new NotificationService(this.db).create({
      userId: job.customerId,
      type: NOTIFICATION_TYPE.OFFER_RECEIVED,
      title: "Offer received",
      message: `A supplier submitted an offer for ${job.title}.`,
      metadata: {
        jobId: job.id,
        offerId: offer.id,
      },
    });

    return offer;
  }

  async acceptBroadcastJob(input: { jobId: string; supplierId: string }) {
    await this.assertApprovedSupplier(input.supplierId);
    const job = await this.db.job.findUnique({ where: { id: input.jobId } });
    if (!job || job.status !== JOB_STATUS.OPEN || job.jobType !== JOB_TYPE.BROADCAST) {
      throw new Error("Broadcast job is not available");
    }
    if (!job.firstSupplierCanAccept) {
      throw new Error("This broadcast job requires customer offer approval");
    }

    const offer = await this.db.offer.upsert({
      where: { jobId_supplierId: { jobId: input.jobId, supplierId: input.supplierId } },
      update: { price: job.budget, message: "Instant acceptance for broadcast job", status: OFFER_STATUS.PENDING },
      create: {
        jobId: input.jobId,
        supplierId: input.supplierId,
        price: job.budget,
        message: "Instant acceptance for broadcast job",
      },
    });

    return this.assignOffer({ customerId: job.customerId, offerId: offer.id });
  }

  async assignOffer(input: { customerId: string; offerId: string }) {
    const offer = await this.db.offer.findUnique({ where: { id: input.offerId }, include: { job: true } });
    if (!offer || offer.job.customerId !== input.customerId) {
      throw new Error("Offer not found for customer");
    }
    if (offer.job.status !== JOB_STATUS.OPEN) {
      throw new Error("Job is not open for assignment");
    }

    const fees = calculateMarketplaceFees(offer.price);
    const wallet = new WalletService(this.db);
    await wallet.reserveFunds({
      userId: input.customerId,
      amount: fees.customerTotal,
      description: `Reserved payment for ${offer.job.title}`,
      relatedJobId: offer.job.id,
      relatedOfferId: offer.id,
    });

    const [job] = await Promise.all([
      this.db.job.update({
        where: { id: offer.jobId },
        data: {
          supplierId: offer.supplierId,
          acceptedOfferId: offer.id,
          status: JOB_STATUS.ASSIGNED,
        },
      }),
      this.db.offer.update({ where: { id: offer.id }, data: { status: OFFER_STATUS.ACCEPTED } }),
      this.db.offer.updateMany({
        where: { jobId: offer.jobId, id: { not: offer.id } },
        data: { status: OFFER_STATUS.REJECTED },
      }),
    ]);

    const notifications = new NotificationService(this.db);
    await Promise.all([
      notifications.create({
        userId: offer.supplierId,
        type: NOTIFICATION_TYPE.JOB_ASSIGNED,
        title: "Job assigned",
        message: `You were assigned ${offer.job.title}.`,
        metadata: {
          jobId: offer.job.id,
        },
      }),
      notifications.create({
        userId: input.customerId,
        type: NOTIFICATION_TYPE.JOB_ASSIGNED,
        title: "Supplier assigned",
        message: `A supplier was assigned to ${offer.job.title}.`,
        metadata: {
          jobId: offer.job.id,
          supplierId: offer.supplierId,
        },
      }),
    ]);

    return job;
  }

  async startJob(input: { supplierId: string; jobId: string }) {
    const job = await this.db.job.findUnique({ where: { id: input.jobId } });
    if (!job || job.supplierId !== input.supplierId || job.status !== JOB_STATUS.ASSIGNED) {
      throw new Error("Job cannot be started");
    }
    return this.db.job.update({ where: { id: input.jobId }, data: { status: JOB_STATUS.IN_PROGRESS } });
  }

  async submitCompletion(input: { supplierId: string; jobId: string; notes: string; photoUrls: string[] }) {
    const job = await this.db.job.findUnique({ where: { id: input.jobId }, include: { acceptedOffer: true } });
    if (!job || job.supplierId !== input.supplierId || !([JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS] as string[]).includes(job.status) || !job.acceptedOffer) {
      throw new Error("Job cannot be completed");
    }

    const fees = calculateMarketplaceFees(job.acceptedOffer.price);
    await new WalletService(this.db).moveReservedToSupplierPending({
      customerId: job.customerId,
      supplierId: input.supplierId,
      reservedAmount: fees.customerTotal,
      supplierPendingAmount: fees.supplierReceives,
      platformFeeAmount: fees.platformFeeTotal,
      jobId: job.id,
    });

    const approvalDueAt = new Date(Date.now() + appConfig.approvalWindowHours * 60 * 60 * 1000);
    const updated = await this.db.job.update({
      where: { id: input.jobId },
      data: {
        status: JOB_STATUS.AWAITING_APPROVAL,
        completionNotes: input.notes,
        completionPhotoUrls: JSON.stringify(input.photoUrls),
        completedAt: new Date(),
        approvalDueAt,
      },
    });

    await new NotificationService(this.db).create({
      userId: job.customerId,
      type: NOTIFICATION_TYPE.JOB_COMPLETED,
      title: "Job completed",
      message: `${job.title} is ready for review.`,
      metadata: {
        jobId: job.id,
      },
    });

    return updated;
  }

  async approveCompletion(input: { customerId: string; jobId: string }) {
    const job = await this.db.job.findUnique({ where: { id: input.jobId }, include: { acceptedOffer: true } });
    if (!job || job.customerId !== input.customerId || job.status !== JOB_STATUS.AWAITING_APPROVAL || !job.supplierId || !job.acceptedOffer) {
      throw new Error("Job is not awaiting customer approval");
    }

    const fees = calculateMarketplaceFees(job.acceptedOffer.price);
    await new WalletService(this.db).releaseSupplierPending({
      userId: job.supplierId,
      amount: fees.supplierReceives,
      description: `Released payment for ${job.title}`,
      relatedJobId: job.id,
    });

    const updated = await this.db.job.update({
      where: { id: input.jobId },
      data: { status: JOB_STATUS.CLOSED, closedAt: new Date() },
    });
    await new NotificationService(this.db).create({
      userId: job.supplierId,
      type: NOTIFICATION_TYPE.PAYMENT_RELEASED,
      title: "Payment released",
      message: `Payment for ${job.title} is now available.`,
      metadata: {
        jobId: job.id,
      },
    });
    return updated;
  }

  async disputeCompletion(input: { customerId: string; jobId: string }) {
    const job = await this.db.job.findUnique({ where: { id: input.jobId } });
    if (!job || job.customerId !== input.customerId || job.status !== JOB_STATUS.AWAITING_APPROVAL) {
      throw new Error("Job is not awaiting customer approval");
    }
    return this.db.job.update({ where: { id: input.jobId }, data: { status: JOB_STATUS.DISPUTED } });
  }

  async autoReleaseDueJobs(now = new Date()) {
    const dueJobs = await this.db.job.findMany({
      where: { status: JOB_STATUS.AWAITING_APPROVAL, approvalDueAt: { lte: now } },
      include: { acceptedOffer: true },
    });

    const released = [];
    for (const job of dueJobs) {
      if (job.supplierId) {
        released.push(await this.approveCompletion({ customerId: job.customerId, jobId: job.id }));
      }
    }
    return released;
  }

  private async assertApprovedSupplier(userId: string) {
    const supplier = await this.db.user.findUnique({
      where: { id: userId },
      include: { supplierProfile: true },
    });
    if (!supplier || supplier.role !== ROLE.SUPPLIER || supplier.supplierProfile?.status !== SUPPLIER_STATUS.APPROVED) {
      throw new Error("Supplier must be approved");
    }
  }

  private async findMatchingSuppliers(category: string, location: string) {
    const normalizedCategory = category.toLowerCase();
    const normalizedLocation = location.toLowerCase();
    const suppliers = await this.db.supplierProfile.findMany({
      where: { status: SUPPLIER_STATUS.APPROVED },
      select: { userId: true, services: true, location: true },
    });

    return suppliers.filter((supplier) => {
      let services: string[] = [];
      try {
        services = JSON.parse(supplier.services) as string[];
      } catch {
        services = [];
      }
      const location = supplier.location.toLowerCase();
      return (
        services.map((service) => service.toLowerCase()).includes(normalizedCategory) &&
        (location.includes(normalizedLocation) || normalizedLocation.includes(location))
      );
    });
  }
}
