import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { ROLE } from "@/lib/types";
import { handleRouteError } from "@/lib/http";
import { JobService } from "@/services/job-service";

export async function POST(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  try {
    const user = await requireUser([ROLE.CUSTOMER]);
    const { offerId } = await params;
    const job = await prisma.$transaction((tx) => new JobService(tx).assignOffer({ customerId: user.id, offerId }));
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
      return NextResponse.redirect(new URL("/customer", request.url), { status: 303 });
    }
    return NextResponse.json({ job });
  } catch (error) {
    return handleRouteError(error);
  }
}
