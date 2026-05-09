"use server";

import { redirect } from "next/navigation";
import { registerUser } from "@/services/user-service";

export async function signupAction(formData: FormData) {
  const role = String(formData.get("role"));

  if (role === "CUSTOMER") {
    await registerUser({
      role,
      name: formData.get("name"),
      email: formData.get("email"),
      phone: formData.get("phone"),
      password: formData.get("password"),
      companyName: formData.get("companyName"),
      location: formData.get("location")
    });
  } else {
    await registerUser({
      role: "SUPPLIER",
      businessName: formData.get("businessName"),
      contactName: formData.get("contactName"),
      email: formData.get("email"),
      phone: formData.get("phone"),
      password: formData.get("password"),
      location: formData.get("location"),
      services: formData.getAll("services"),
      description: formData.get("description"),
      rate: formData.get("rate"),
      rateType: formData.get("rateType"),
      availability: formData.get("availability")
    });
  }

  redirect("/login?registered=1");
}
