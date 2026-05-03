import { NextResponse } from "next/server";
import { ROLE } from "@/lib/types";
import { withdrawSchema } from "@/lib/validation";
import { handleRouteError, parseRequestBody } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { WalletService } from "@/services/wallet-service";

export async function POST(request: Request) {
  try {
    const user = await requireUser([ROLE.SUPPLIER]);
    const raw = await parseRequestBody(request);
    const body = withdrawSchema.parse({ ...raw, amount: Math.round(Number(raw.amount) * 100) });
    const wallet = await prisma.$transaction((tx) =>
      new WalletService(tx).withdraw({
        userId: user.id,
        amount: body.amount,
        description: "Simulated supplier withdrawal",
      }),
    );
    if ((request.headers.get("content-type") ?? "").includes("application/json")) {
      return NextResponse.json({ wallet });
    }
    return NextResponse.redirect(new URL("/supplier", request.url), { status: 303 });
  } catch (error) {
    return handleRouteError(error);
  }
}
