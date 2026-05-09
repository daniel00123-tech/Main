import type { Metadata } from "next";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { SignOutButton } from "@/components/sign-out-button";
import "./globals.css";

export const metadata: Metadata = {
  title: "Contractor Marketplace MVP",
  description: "B2B facilities management contractor marketplace"
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  const dashboardHref =
    session?.user.role === "ADMIN"
      ? "/admin"
      : session?.user.role === "CUSTOMER"
        ? "/customer"
        : session?.user.role === "SUPPLIER"
          ? "/supplier"
          : "/";

  return (
    <html lang="en">
      <body>
        <header className="border-b border-slate-200 bg-white">
          <nav className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
            <Link href="/" className="text-lg font-black">
              Contractor Market
            </Link>
            <div className="flex items-center gap-3 text-sm font-semibold">
              {session?.user ? (
                <>
                  <Link href={dashboardHref}>Dashboard</Link>
                  <span className="rounded-full bg-slate-100 px-3 py-1">{session.user.role}</span>
                  <SignOutButton />
                </>
              ) : (
                <>
                  <Link href="/login">Log in</Link>
                  <Link href="/signup" className="button">
                    Sign up
                  </Link>
                </>
              )}
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
