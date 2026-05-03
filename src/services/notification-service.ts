import { Prisma, PrismaClient } from "@prisma/client";
import type { NotificationType } from "@/lib/types";

type NotificationInput = {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export class NotificationService {
  constructor(private readonly db: Prisma.TransactionClient | PrismaClient) {}

  async create(input: NotificationInput) {
    return this.db.notification.create({
      data: {
        ...input,
        metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
      },
    });
  }

  async createMany(inputs: NotificationInput[]) {
    if (!inputs.length) {
      return { count: 0 };
    }

    return this.db.notification.createMany({
      data: inputs.map((input) => ({
        ...input,
        metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
      })),
    });
  }
}
