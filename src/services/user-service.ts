import { hash } from "bcryptjs";
import { Role, SupplierStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { registrationSchema } from "@/lib/validation";
import { ensureWallet } from "@/services/wallet-service";
import { notifyUser } from "@/services/notification-service";

export async function registerUser(rawInput: unknown) {
  const input = registrationSchema.parse(rawInput);
  const email = input.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    throw new Error("An account already exists for this email address.");
  }

  const passwordHash = await hash(input.password, 12);

  if (input.role === "CUSTOMER") {
    const user = await prisma.user.create({
      data: {
        email,
        phone: input.phone,
        name: input.name,
        passwordHash,
        role: Role.CUSTOMER,
        customerProfile: {
          create: {
            companyName: input.companyName,
            location: input.location
          }
        },
        wallet: {
          create: {}
        }
      },
      include: {
        customerProfile: true,
        wallet: true
      }
    });

    return user;
  }

  const user = await prisma.user.create({
    data: {
      email,
      phone: input.phone,
      name: input.contactName,
      passwordHash,
      role: Role.SUPPLIER,
      supplierProfile: {
        create: {
          businessName: input.businessName,
          contactName: input.contactName,
          location: input.location,
          services: input.services,
          description: input.description,
          rate: input.rate,
          rateType: input.rateType,
          availability: input.availability,
          status: SupplierStatus.PENDING
        }
      },
      wallet: {
        create: {}
      }
    },
    include: {
      supplierProfile: true,
      wallet: true
    }
  });

  return user;
}

export async function createAdminUser(input: {
  name: string;
  email: string;
  password: string;
  phone?: string;
}) {
  const email = input.email.toLowerCase();
  const passwordHash = await hash(input.password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      name: input.name,
      email,
      phone: input.phone,
      passwordHash,
      role: Role.ADMIN,
      wallet: {
        create: {}
      }
    },
    update: {
      name: input.name,
      phone: input.phone,
      passwordHash,
      role: Role.ADMIN
    }
  });

  await ensureWallet(user.id);
  return user;
}

export async function reviewSupplier(input: {
  supplierUserId: string;
  status: "APPROVED" | "REJECTED";
}) {
  const profile = await prisma.supplierProfile.update({
    where: { userId: input.supplierUserId },
    data: {
      status: input.status,
      reviewedAt: new Date()
    },
    include: {
      user: true
    }
  });

  await notifyUser({
    userId: input.supplierUserId,
    type: "SUPPLIER_REVIEWED",
    title: `Supplier profile ${input.status.toLowerCase()}`,
    message:
      input.status === SupplierStatus.APPROVED
        ? "Your supplier profile is approved and visible for jobs."
        : "Your supplier profile was rejected. Please contact support for details."
  });

  return profile;
}
