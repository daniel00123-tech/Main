import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ROLE } from "@/lib/types";
import { jobCreateSchema } from "@/lib/validation";
import { handleRouteError, parseRequestBody } from "@/lib/http";
import { JobService } from "@/services/job-service";

export async function GET() {
  try {
    const user = await requireUser();
    const where =
      user.role === ROLE.CUSTOMER
        ? { customerId: user.id }
        : user.role === ROLE.SUPPLIER
          ? { OR: [{ status: "OPEN" }, { supplierId: user.id }] }
          : {};
    const jobs = await prisma.job.findMany({
      where,
      include: {
        customer: { select: { name: true, customerProfile: true } },
        supplier: { select: { name: true, supplierProfile: true } },
        offers: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ jobs });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser([ROLE.CUSTOMER]);
    const raw = await parseRequestBody(request);
    const payload = jobCreateSchema.parse({
      ...raw,
      budget: Math.round(Number(raw.budget) * 100),
      firstSupplierCanAccept: raw.firstSupplierCanAccept === "on" || raw.firstSupplierCanAccept === true,
    });
    const job = await prisma.$transaction((tx) =>
      new JobService(tx).createJob({
        customerId: user.id,
        title: payload.title,
        description: payload.description,
        category: payload.category,
        location: payload.location,
        budget: payload.budget,
        deadline: new Date(payload.deadline),
        jobType: payload.jobType,
        firstSupplierCanAccept: payload.firstSupplierCanAccept,
      }),
    );
    if ((request.headers.get("content-type") ?? "").includes("application/json")) {
      return NextResponse.json({ job }, { status: 201 });
    }
    return NextResponse.redirect(new URL("/customer", request.url), { status: 303 });
  } catch (error) {
    return handleRouteError(error);
  }
}
