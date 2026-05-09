import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export default async function HomePage() {
  const session = await getServerSession(authOptions);
  const dashboard =
    session?.user.role === "ADMIN" ? "/admin" : session?.user.role === "CUSTOMER" ? "/customer" : "/supplier";

  return (
    <section className="grid gap-8">
      <div className="card grid gap-5 bg-slate-950 text-white">
        <p className="text-sm font-bold uppercase tracking-[0.3em] text-emerald-300">
          B2B contractor marketplace
        </p>
        <h1 className="max-w-3xl text-5xl font-black leading-tight">
          Facilities teams post work. Approved subcontractors bid or accept broadcast jobs.
        </h1>
        <p className="max-w-2xl text-lg text-slate-300">
          A structured MVP with role-based access, supplier approval, wallets, simulated payments,
          fees, notifications, and a Stripe-ready payment service layer.
        </p>
        <div className="flex gap-3">
          {session ? (
            <Link href={dashboard} className="button bg-emerald-400 text-slate-950">
              Open dashboard
            </Link>
          ) : (
            <>
              <Link href="/signup" className="button bg-emerald-400 text-slate-950">
                Create account
              </Link>
              <Link href="/login" className="button button-secondary">
                Log in
              </Link>
            </>
          )}
        </div>
      </div>

      <div className="grid-auto">
        {[
          ["Bidding marketplace", "Suppliers browse open jobs and submit priced offers."],
          ["Broadcast workflow", "Matching suppliers are notified by service category and location."],
          ["Wallet escrow simulation", "Customer funds are reserved, released, refunded, or withdrawn through services."],
          ["Platform fees", "10% customer fee plus £1 supplier fee calculated centrally."]
        ].map(([title, copy]) => (
          <div key={title} className="card">
            <h2 className="text-xl font-black">{title}</h2>
            <p className="mt-2 text-slate-600">{copy}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
