import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { Role } from "@/generated/prisma/client";
import { authOptions } from "@/lib/auth";
import { submitOffer } from "@/services/job-service";

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user || session.user.role !== Role.SUPPLIER) {
    return NextResponse.json({ error: "Only suppliers can submit offers." }, { status: 403 });
  }

  try {
    const body = await request.json();
    const offer = await submitOffer(session.user.id, body);
    return NextResponse.json({ offer }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to submit offer." },
      { status: 400 }
    );
  }
}
