import { Role } from "@/generated/prisma/client";
import { StatCard } from "@/components/stat-card";
import { StatusPill } from "@/components/status-pill";
import { formatCurrency } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/rbac";
import { serviceCategories } from "@/lib/validation";
import {
  acceptOfferAction,
  addFundsAction,
  approveCompletionAction,
  createJobAction,
  disputeCompletionAction
} from "@/app/customer/actions";

export default async function CustomerPage() {
  const session = await requireRole([Role.CUSTOMER]);
  const [wallet, jobs, notifications] = await Promise.all([
    prisma.wallet.findUnique({
      where: { userId: session.user.id },
      include: { transactions: { orderBy: { createdAt: "desc" }, take: 10 } }
    }),
    prisma.job.findMany({
      where: { customerId: session.user.id },
      include: {
        offers: { include: { supplier: { include: { supplierProfile: true } } }, orderBy: { createdAt: "desc" } },
        assignedSupplier: { include: { supplierProfile: true } }
      },
      orderBy: { createdAt: "desc" }
    }),
    prisma.notification.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      take: 8
    })
  ]);

  const offersReceived = jobs.reduce((count, job) => count + job.offers.length, 0);

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-3xl font-black">Customer dashboard</h1>
        <p className="text-slate-600">Post jobs, review offers, approve work, and manage wallet funding.</p>
      </div>

      <div className="grid-auto">
        <StatCard label="Jobs posted" value={jobs.length} />
        <StatCard label="Offers received" value={offersReceived} />
        <StatCard label="Assigned jobs" value={jobs.filter((job) => job.assignedSupplierId).length} />
        <StatCard label="Wallet available" value={formatCurrency(wallet?.balance ?? 0)} />
        <StatCard label="Wallet reserved" value={formatCurrency(wallet?.reservedBalance ?? 0)} />
      </div>

      <section className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <form action={createJobAction.bind(null, session.user.id)} className="card grid gap-4">
          <h2 className="text-xl font-black">Create job</h2>
          <label>
            Title
            <input name="title" required />
          </label>
          <label>
            Description
            <textarea name="description" required minLength={20} />
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            <label>
              Category
              <select name="category">
                {serviceCategories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Location
              <input name="location" placeholder="London" required />
            </label>
            <label>
              Budget
              <input name="budget" type="number" min="1" step="0.01" required />
            </label>
            <label>
              Deadline
              <input name="deadline" type="date" required />
            </label>
            <label>
              Job type
              <select name="type">
                <option value="BIDDING">Bidding marketplace</option>
                <option value="BROADCAST">Broadcast to matching suppliers</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input className="w-auto" name="autoAssign" type="checkbox" />
              First broadcast accept assigns supplier
            </label>
          </div>
          <button type="submit">Post job</button>
        </form>

        <div className="grid gap-4">
          <form action={addFundsAction.bind(null, session.user.id)} className="card grid gap-3">
            <h2 className="text-xl font-black">Add funds</h2>
            <p className="text-sm text-slate-600">Simulates a customer wallet top-up.</p>
            <label>
              Amount
              <input name="amount" type="number" min="1" step="0.01" required />
            </label>
            <button type="submit">Add simulated funds</button>
          </form>

          <div className="card">
            <h2 className="mb-3 text-xl font-black">Notifications</h2>
            <div className="grid gap-2 text-sm">
              {notifications.map((notification) => (
                <div key={notification.id} className="rounded-xl bg-slate-50 p-3">
                  <strong>{notification.title}</strong>
                  <p className="text-slate-600">{notification.message}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="card grid gap-4">
        <h2 className="text-xl font-black">Your jobs</h2>
        {jobs.map((job) => (
          <article key={job.id} className="rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-black">{job.title}</h3>
                <p className="text-sm text-slate-600">
                  {job.type} · {job.category} · {job.location} · {formatCurrency(job.budget)}
                </p>
              </div>
              <StatusPill value={job.status} />
            </div>

            {job.assignedSupplier ? (
              <p className="mt-3 text-sm">
                Assigned supplier:{" "}
                <strong>{job.assignedSupplier.supplierProfile?.businessName ?? job.assignedSupplier.email}</strong>
              </p>
            ) : null}

            {job.status === "AWAITING_APPROVAL" ? (
              <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm">
                <p className="mb-2">
                  Supplier completion notes: <strong>{job.completionNotes}</strong>
                </p>
                <div className="flex gap-2">
                  <form action={approveCompletionAction.bind(null, session.user.id)}>
                    <input type="hidden" name="jobId" value={job.id} />
                    <button type="submit">Approve and release</button>
                  </form>
                  <form action={disputeCompletionAction.bind(null, session.user.id)}>
                    <input type="hidden" name="jobId" value={job.id} />
                    <button className="button-secondary" type="submit">
                      Dispute
                    </button>
                  </form>
                </div>
              </div>
            ) : null}

            {job.offers.length ? (
              <div className="mt-4 grid gap-2">
                <h4 className="font-bold">Offers</h4>
                {job.offers.map((offer) => (
                  <div key={offer.id} className="grid gap-2 rounded-xl bg-slate-50 p-3 text-sm md:grid-cols-[1fr_auto]">
                    <div>
                      <strong>{offer.supplier.supplierProfile?.businessName ?? offer.supplier.email}</strong>
                      <p>{offer.message}</p>
                      <p>{formatCurrency(offer.price)}</p>
                      <StatusPill value={offer.status} />
                    </div>
                    {job.status === "OPEN" && offer.status === "PENDING" ? (
                      <form action={acceptOfferAction.bind(null, session.user.id)} className="self-center">
                        <input type="hidden" name="offerId" value={offer.id} />
                        <button type="submit">Accept offer</button>
                      </form>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </section>

      <section className="card">
        <h2 className="mb-3 text-xl font-black">Payment history</h2>
        <div className="grid gap-2">
          {wallet?.transactions.map((transaction) => (
            <div key={transaction.id} className="flex items-center justify-between rounded-xl border p-3 text-sm">
              <span>{transaction.description}</span>
              <strong>{formatCurrency(transaction.amount)}</strong>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
