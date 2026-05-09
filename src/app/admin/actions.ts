"use server";

import { revalidatePath } from "next/cache";
import { SupplierStatus } from "@/generated/prisma/client";
import { reviewSupplier } from "@/services/user-service";

export async function approveSupplierAction(formData: FormData) {
  await reviewSupplier({
    supplierUserId: String(formData.get("supplierUserId")),
    status: SupplierStatus.APPROVED
  });
  revalidatePath("/admin");
}

export async function rejectSupplierAction(formData: FormData) {
  await reviewSupplier({
    supplierUserId: String(formData.get("supplierUserId")),
    status: SupplierStatus.REJECTED
  });
  revalidatePath("/admin");
}
