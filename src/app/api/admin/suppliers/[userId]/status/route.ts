import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { handleRouteError, parseRequestBody } from "@/lib/http";
import { NOTIFICATION_TYPE, ROLE, SUPPLIER_STATUS } from "@/lib/types";
import { supplierApprovalSchema } from "@/lib/validation";
import { prisma } from "@/lib/prisma";
import { NotificationService } from "@/services/notification-service";

export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    await requireUser([ROLE.ADMIN]);
    const { userId } = await params;
    const contentType = request.headers.get("content-type") ?? "";
    const raw = await parseRequestBody(request);
    const input = supplierApprovalSchema.parse(raw);

    const supplier = await prisma.supplierProfile.update({
      where: { userId },
      data: { status: input.status },
      include: { user: true },
    });

    await new NotificationService(prisma).create({
      userId,
      type: input.status === SUPPLIER_STATUS.APPROVED ? NOTIFICATION_TYPE.SUPPLIER_APPROVED : NOTIFICATION_TYPE.SUPPLIER_REJECTED,
      title: input.status === SUPPLIER_STATUS.APPROVED ? "Supplier approved" : "Supplier rejected",
      message:
        input.status === SUPPLIER_STATUS.APPROVED
          ? "Your supplier profile is now live."
          : "Your supplier profile was rejected. Please contact support for details.",
    });

    if (!contentType.includes("application/json")) {
      return NextResponse.redirect(new URL("/admin", request.url), { status: 303 });
    }
    return NextResponse.json({ supplier });
  } catch (error) {
    return handleRouteError(error);
  }
}
