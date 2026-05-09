"use server";

import { revalidatePath } from "next/cache";
import {
  acceptBroadcastJob,
  markJobComplete,
  startJob,
  submitOffer
} from "@/services/job-service";
import { withdrawFunds } from "@/services/wallet-service";

export async function submitOfferAction(userId: string, formData: FormData) {
  await submitOffer(userId, {
    jobId: formData.get("jobId"),
    price: formData.get("price"),
    message: formData.get("message")
  });
  revalidatePath("/supplier");
}

export async function acceptBroadcastAction(userId: string, formData: FormData) {
  await acceptBroadcastJob(userId, String(formData.get("jobId")));
  revalidatePath("/supplier");
}

export async function startJobAction(userId: string, formData: FormData) {
  await startJob(userId, String(formData.get("jobId")));
  revalidatePath("/supplier");
}

export async function completeJobAction(userId: string, formData: FormData) {
  await markJobComplete(userId, {
    jobId: formData.get("jobId"),
    notes: formData.get("notes"),
    photoUrls: formData.get("photoUrls")
  });
  revalidatePath("/supplier");
}

export async function withdrawAction(userId: string, formData: FormData) {
  await withdrawFunds(userId, String(formData.get("amount")));
  revalidatePath("/supplier");
}
