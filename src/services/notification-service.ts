import type { NotificationType } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export async function notifyUser(input: {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
}) {
  return prisma.notification.create({
    data: input
  });
}

export async function notifyUsers(inputs: Array<Parameters<typeof notifyUser>[0]>) {
  if (!inputs.length) {
    return;
  }

  await prisma.notification.createMany({
    data: inputs
  });
}
