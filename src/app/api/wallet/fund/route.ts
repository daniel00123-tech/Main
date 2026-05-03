import { NextResponse } from "next/server";
import { ROLE } from "@/lib/types";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { walletFundingSchema } from "@/lib/validation";
import { WalletService } from "@/services/wallet-service";
import { handleRouteError, parseRequestBody } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const user = await requireUser([ROLE.CUSTOMER]);
    const contentType = request.headers.get("content-type") ?? "";
    const raw = await parseRequestBody(request);
    const input = walletFundingSchema.parse({ ...raw, amount: Math.round(Number(raw.amount) * 100) });
    const wallet = await prisma.$transaction((tx) =>
      new WalletService(tx).addFunds({
        userId: user.id,
        amount: input.amount,
        description: "Simulated customer wallet funding",
      }),
    );
    if (contentType.includes("application/json")) {
      return NextResponse.json({ wallet });
    }
    return NextResponse.redirect(new URL("/customer", request.url), { status: 303 });
  } catch (error) {
    return handleRouteError(error);
  }
}
