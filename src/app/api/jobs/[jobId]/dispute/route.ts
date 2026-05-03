import { NextResponse } from "next/server";
import { ROLE } from "@/lib/types";
import { requireUser } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { JobService } from "@/services/job-service";

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser([ROLE.CUSTOMER]);
    const { jobId } = await context.params;
    const job = await prisma.$transaction((tx) => new JobService(tx).disputeCompletion({ customerId: user.id, jobId }));
    if (!(_request.headers.get("content-type") ?? "").includes("application/json")) {
      return NextResponse.redirect(new URL("/customer", _request.url), { status: 303 });
    }
    return NextResponse.json({ job });
  } catch (error) {
    return handleRouteError(error);
  }
}
