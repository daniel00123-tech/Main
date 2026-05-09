import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { Role } from "@/generated/prisma/client";
import { authOptions } from "@/lib/auth";

export async function requireRole(roles: Role[]) {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    redirect("/login");
  }

  if (!roles.includes(session.user.role)) {
    redirect("/");
  }

  return session;
}

export async function requireUser() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    redirect("/login");
  }

  return session;
}
