import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { Role } from "@/generated/prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createJob } from "@/services/job-service";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobs = await prisma.job.findMany({
    where:
      session.user.role === Role.CUSTOMER
        ? { customerId: session.user.id }
        : session.user.role === Role.SUPPLIER
          ? { status: "OPEN" }
          : {},
    include: {
      offers: true,
      assignedSupplier: { include: { supplierProfile: true } }
    },
    orderBy: { createdAt: "desc" }
  });

  return NextResponse.json({ jobs });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user || session.user.role !== Role.CUSTOMER) {
    return NextResponse.json({ error: "Only customers can create jobs." }, { status: 403 });
  }

  try {
    const body = await request.json();
    const job = await createJob(session.user.id, body);
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create job." },
      { status: 400 }
    );
  }
}
