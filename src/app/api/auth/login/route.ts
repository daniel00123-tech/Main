import { NextResponse } from "next/server";
import { authenticate, setSession } from "@/lib/auth";
import { getDashboardRedirect } from "@/lib/dashboard";
import { parseRequestBody } from "@/lib/http";
import { loginSchema } from "@/lib/validation";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const raw = await parseRequestBody(request);
  const payload = loginSchema.safeParse(raw);
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const user = await authenticate(payload.data.email, payload.data.password);
  if (!user) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  await setSession(user);
  if (!contentType.includes("application/json")) {
    return NextResponse.redirect(new URL(await getDashboardRedirect(user.role), request.url), { status: 303 });
  }
  return NextResponse.json({ user });
}
