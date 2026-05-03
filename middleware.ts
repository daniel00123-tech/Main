import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

import { authCookieName } from "@/lib/auth";
import { appConfig } from "@/lib/config";
import { ROLE, type Role } from "@/lib/types";

const encoder = new TextEncoder();

const protectedRoutes: Array<{ prefix: string; roles: Role[] }> = [
  { prefix: "/admin", roles: [ROLE.ADMIN] },
  { prefix: "/customer", roles: [ROLE.CUSTOMER] },
  { prefix: "/supplier", roles: [ROLE.SUPPLIER] },
];

export async function middleware(request: NextRequest) {
  const rule = protectedRoutes.find((route) => request.nextUrl.pathname.startsWith(route.prefix));
  if (!rule) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  const token = request.cookies.get(authCookieName)?.value;
  if (!token) {
    return NextResponse.redirect(loginUrl);
  }

  try {
    const verified = await jwtVerify(token, encoder.encode(appConfig.authSecret));
    const role = (verified.payload as { user?: { role?: Role } }).user?.role;
    if (!role || !rule.roles.includes(role)) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    return NextResponse.next();
  } catch {
    return NextResponse.redirect(loginUrl);
  }
}

export const config = {
  matcher: ["/admin/:path*", "/customer/:path*", "/supplier/:path*"],
};
