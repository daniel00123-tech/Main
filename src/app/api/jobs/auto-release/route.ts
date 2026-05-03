import { NextResponse } from "next/server";
import { ROLE } from "@/lib/types";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { handleRouteError } from "@/lib/http";
import { JobService } from "@/services/job-service";

export async function POST() {
  try {
    await requireUser([ROLE.ADMIN]);
    const released = await prisma.$transaction((tx) => new JobService(tx).autoReleaseDueJobs());
    return NextResponse.json({ releasedCount: released.length });
  } catch (error) {
    return handleRouteError(error);
  }
}
