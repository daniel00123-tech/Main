"use server";

import { revalidatePath } from "next/cache";
import {
  acceptOffer,
  approveCompletion,
  createJob,
  disputeCompletion
} from "@/services/job-service";
import { addFunds } from "@/services/wallet-service";

export async function addFundsAction(userId: string, formData: FormData) {
  await addFunds(userId, String(formData.get("amount")));
  revalidatePath("/customer");
}

export async function createJobAction(userId: string, formData: FormData) {
  await createJob(userId, {
    title: formData.get("title"),
    description: formData.get("description"),
    category: formData.get("category"),
    location: formData.get("location"),
    budget: formData.get("budget"),
    deadline: formData.get("deadline"),
    type: formData.get("type"),
    autoAssign: formData.get("autoAssign") === "on"
  });
  revalidatePath("/customer");
}

export async function acceptOfferAction(userId: string, formData: FormData) {
  await acceptOffer(userId, String(formData.get("offerId")));
  revalidatePath("/customer");
}

export async function approveCompletionAction(userId: string, formData: FormData) {
  await approveCompletion(userId, String(formData.get("jobId")));
  revalidatePath("/customer");
}

export async function disputeCompletionAction(userId: string, formData: FormData) {
  await disputeCompletion(userId, String(formData.get("jobId")));
  revalidatePath("/customer");
}
