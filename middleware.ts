import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
  function middleware(req) {
    const role = req.nextauth.token?.role;
    const path = req.nextUrl.pathname;

    if (path.startsWith("/admin") && role !== "ADMIN") {
      return NextResponse.redirect(new URL("/", req.url));
    }

    if (path.startsWith("/customer") && role !== "CUSTOMER") {
      return NextResponse.redirect(new URL("/", req.url));
    }

    if (path.startsWith("/supplier") && role !== "SUPPLIER") {
      return NextResponse.redirect(new URL("/", req.url));
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ token }) => Boolean(token)
    }
  }
);

export const config = {
  matcher: ["/admin/:path*", "/customer/:path*", "/supplier/:path*", "/api/jobs/:path*", "/api/offers/:path*"]
};
