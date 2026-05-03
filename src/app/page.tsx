import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { ROLE } from "@/lib/types";

export default async function HomePage() {
  const user = await getSessionUser();
  if (user?.role === ROLE.ADMIN) redirect("/admin");
  if (user?.role === ROLE.CUSTOMER) redirect("/customer");
  if (user?.role === ROLE.SUPPLIER) redirect("/supplier");

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-10">
      <nav className="flex items-center justify-between">
        <div className="text-xl font-bold">Contractor Exchange</div>
        <div className="flex gap-3">
          <Link className="rounded-full border px-4 py-2 text-sm font-semibold" href="/login">
            Sign in
          </Link>
          <Link className="rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white" href="/signup">
            Join
          </Link>
        </div>
      </nav>

      <section className="grid flex-1 items-center gap-10 py-20 md:grid-cols-[1.2fr_0.8fr]">
        <div>
          <p className="mb-4 text-sm font-bold uppercase tracking-[0.3em] text-blue-700">B2B contractor marketplace</p>
          <h1 className="text-5xl font-black tracking-tight text-slate-950 md:text-6xl">
            FM companies post work. Approved subcontractors deliver it.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">
            A clean MVP with bidding and broadcast workflows, supplier approval, wallet reservations,
            simulated payments, platform fees, and role-based operations.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link className="rounded-full bg-blue-700 px-5 py-3 font-semibold text-white" href="/signup?role=CUSTOMER">
              Post jobs as a customer
            </Link>
            <Link className="rounded-full border px-5 py-3 font-semibold" href="/signup?role=SUPPLIER">
              Apply as a supplier
            </Link>
          </div>
        </div>
        <div className="rounded-3xl border bg-white p-6 shadow-sm">
          {[
            ["Broadcast matching", "Notify suppliers by category and location."],
            ["Wallet escrow", "Reserve funds on assignment, release after approval."],
            ["Stripe-ready", "Provider interface separates payment plumbing."],
          ].map(([title, body]) => (
            <div key={title} className="border-b py-5 last:border-b-0">
              <h2 className="font-bold text-slate-950">{title}</h2>
              <p className="mt-1 text-sm text-slate-600">{body}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
