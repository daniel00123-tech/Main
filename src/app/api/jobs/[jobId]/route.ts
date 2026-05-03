import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { JOB_STATUS, ROLE } from "@/lib/types";

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const user = await requireUser();
    const { jobId } = await params;
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: {
        customer: { select: { id: true, name: true, email: true } },
        supplier: { select: { id: true, name: true, email: true } },
        offers: true,
        transactions: true,
      },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if (user.role !== ROLE.ADMIN && job.customerId !== user.id && job.supplierId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ job });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const user = await requireUser([ROLE.CUSTOMER]);
    const contentType = request.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await request.json() : Object.fromEntries(await request.formData());
    const { jobId } = await params;
    if (body._method !== "DELETE") {
      return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.customerId !== user.id || job.status !== JOB_STATUS.OPEN) {
      return NextResponse.json({ error: "Only open jobs can be cancelled by their customer" }, { status: 400 });
    }

    const updated = await prisma.job.update({ where: { id: jobId }, data: { status: JOB_STATUS.CANCELLED } });
    if (contentType.includes("application/json")) {
      return NextResponse.json({ job: updated });
    }
    return NextResponse.redirect(new URL("/customer", request.url), { status: 303 });
  } catch (error) {
    return handleRouteError(error);
  }
}
