import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { ROLE } from "@/lib/types";
import { completeJobSchema } from "@/lib/validation";
import { prisma } from "@/lib/prisma";
import { JobService } from "@/services/job-service";
import { handleRouteError, parseRequestBody } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const user = await requireUser([ROLE.SUPPLIER]);
    const { jobId } = await context.params;
    const raw = await parseRequestBody(request);
    const photoUrls =
      Array.isArray(raw.photoUrls)
        ? raw.photoUrls
        : typeof raw.photoUrls === "string" && raw.photoUrls
          ? raw.photoUrls.split(",").map((url: string) => url.trim()).filter(Boolean)
          : [];
    const body = completeJobSchema.parse({ notes: raw.notes, photoUrls });
    const job = await prisma.$transaction((tx) => new JobService(tx).submitCompletion({ supplierId: user.id, jobId, ...body }));
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
      return NextResponse.redirect(new URL("/supplier", request.url), { status: 303 });
    }
    return NextResponse.json({ job });
  } catch (error) {
    return handleRouteError(error);
  }
}
