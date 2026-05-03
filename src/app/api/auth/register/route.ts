import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, setSession } from "@/lib/auth";
import { ROLE, SUPPLIER_STATUS } from "@/lib/types";
import { customerRegistrationSchema, supplierRegistrationSchema } from "@/lib/validation";
import { handleRouteError, parseRequestBody } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = await parseRequestBody(request);
    if (body.role === ROLE.CUSTOMER && body.customerLocation) {
      body.location = body.customerLocation;
    }
    if (body.role === ROLE.SUPPLIER && body.supplierLocation) {
      body.location = body.supplierLocation;
    }
    if (body.rateAmount) {
      body.rateAmount = Math.round(Number(body.rateAmount) * 100);
    }
    const role = body.role;
    const schema = role === ROLE.CUSTOMER ? customerRegistrationSchema : role === ROLE.SUPPLIER ? supplierRegistrationSchema : null;

    if (!schema) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const passwordHash = await hashPassword(parsed.data.password);
      const user = await tx.user.create({
        data: {
          email: parsed.data.email.toLowerCase(),
          passwordHash,
          name: parsed.data.role === ROLE.CUSTOMER ? parsed.data.name : parsed.data.contactName,
          phone: parsed.data.phone,
          role: parsed.data.role,
          wallet: { create: {} },
        },
      });

      if (parsed.data.role === ROLE.CUSTOMER) {
        await tx.customerProfile.create({
          data: {
            userId: user.id,
            companyName: parsed.data.companyName,
            location: parsed.data.location,
          },
        });
      } else {
        await tx.supplierProfile.create({
          data: {
            userId: user.id,
            businessName: parsed.data.businessName,
            contactName: parsed.data.contactName,
            location: parsed.data.location,
            services: JSON.stringify(parsed.data.services),
            description: parsed.data.description,
            rateType: parsed.data.rateType,
            rateAmount: parsed.data.rateAmount,
            availability: parsed.data.availability,
            status: SUPPLIER_STATUS.PENDING,
          },
        });
      }

      return user;
    });

    await setSession({ id: result.id, email: result.email, name: result.name, role: parsed.data.role });
    if ((request.headers.get("content-type") ?? "").includes("application/json")) {
      return NextResponse.json({ user: { id: result.id, email: result.email, role: parsed.data.role, name: result.name } }, { status: 201 });
    }
    return NextResponse.redirect(new URL(`/${parsed.data.role.toLowerCase()}`, request.url), { status: 303 });
  } catch (error) {
    return handleRouteError(error);
  }
}
