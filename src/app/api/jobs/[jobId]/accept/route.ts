import { NextResponse } from "next/server";
import { ROLE } from "@/lib/types";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { JobService } from "@/services/job-service";
import { handleRouteError } from "@/lib/http";

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const user = await requireUser([ROLE.SUPPLIER]);
    const { jobId } = await params;
    const job = await prisma.$transaction((tx) => new JobService(tx).acceptBroadcastJob({ jobId, supplierId: user.id }));
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
      return NextResponse.redirect(new URL("/supplier", request.url), { status: 303 });
    }
    return NextResponse.json({ job });
  } catch (error) {
    return handleRouteError(error);
  }
}
