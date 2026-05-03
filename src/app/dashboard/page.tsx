import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { ROLE } from "@/lib/types";

export default async function DashboardRedirectPage() {
  const user = await getSessionUser();
  if (!user) {
    redirect("/login");
  }

  if (user.role === ROLE.ADMIN) {
    redirect("/admin");
  }
  if (user.role === ROLE.CUSTOMER) {
    redirect("/customer");
  }
  redirect("/supplier");
}
