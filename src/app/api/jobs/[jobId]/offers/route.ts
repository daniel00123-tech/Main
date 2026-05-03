import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { ROLE } from "@/lib/types";
import { offerSchema } from "@/lib/validation";
import { JobService } from "@/services/job-service";
import { handleRouteError, parseRequestBody } from "@/lib/http";

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const user = await requireUser([ROLE.SUPPLIER]);
    const raw = await parseRequestBody(request);
    const body = offerSchema.parse({ ...raw, price: Math.round(Number(raw.price) * 100) });
    const { jobId } = await params;
    const offer = await prisma.$transaction((tx) =>
      new JobService(tx).submitOffer({
        jobId,
        supplierId: user.id,
        price: body.price,
        message: body.message,
      }),
    );
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
      return NextResponse.redirect(new URL("/supplier", request.url), { status: 303 });
    }
    return NextResponse.json({ offer }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
