import { NextResponse } from "next/server";
import { ROLE } from "@/lib/types";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { handleRouteError } from "@/lib/http";
import { JobService } from "@/services/job-service";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const user = await requireUser([ROLE.CUSTOMER]);
    const { jobId } = await context.params;
    const job = await prisma.$transaction((tx) => new JobService(tx).approveCompletion({ customerId: user.id, jobId }));
    if ((request.headers.get("content-type") ?? "").includes("application/json")) {
      return NextResponse.json({ job });
    }
    return NextResponse.redirect(new URL("/customer", request.url), { status: 303 });
  } catch (error) {
    return handleRouteError(error);
  }
}
