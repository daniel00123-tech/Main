import { JobType, Role } from "@/generated/prisma/client";
import { StatCard } from "@/components/stat-card";
import { StatusPill } from "@/components/status-pill";
import { formatCurrency } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/rbac";
import {
  acceptBroadcastAction,
  completeJobAction,
  startJobAction,
  submitOfferAction,
  withdrawAction
} from "@/app/supplier/actions";

export default async function SupplierPage() {
  const session = await requireRole([Role.SUPPLIER]);
  const [profile, wallet, availableJobs, assignedJobs, notifications] = await Promise.all([
    prisma.supplierProfile.findUnique({ where: { userId: session.user.id } }),
    prisma.wallet.findUnique({
      where: { userId: session.user.id },
      include: { transactions: { orderBy: { createdAt: "desc" }, take: 10 } }
    }),
    prisma.job.findMany({
      where: { status: "OPEN" },
      include: {
        offers: { where: { supplierId: session.user.id } },
        customer: { include: { customerProfile: true } }
      },
      orderBy: { createdAt: "desc" }
    }),
    prisma.job.findMany({
      where: { assignedSupplierId: session.user.id },
      include: { customer: { include: { customerProfile: true } } },
      orderBy: { updatedAt: "desc" }
    }),
    prisma.notification.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      take: 8
    })
  ]);

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-3xl font-black">Supplier dashboard</h1>
        <p className="text-slate-600">Browse jobs, submit offers, complete assigned work, and withdraw earnings.</p>
      </div>

      <div className="grid-auto">
        <StatCard label="Profile status" value={profile?.status ?? "PENDING"} />
        <StatCard label="Available jobs" value={availableJobs.length} />
        <StatCard label="Assigned jobs" value={assignedJobs.length} />
        <StatCard label="Pending earnings" value={formatCurrency(wallet?.pendingBalance ?? 0)} />
        <StatCard label="Available earnings" value={formatCurrency(wallet?.balance ?? 0)} />
      </div>

      {profile?.status !== "APPROVED" ? (
        <div className="card border-amber-200 bg-amber-50">
          <h2 className="font-black">Approval required</h2>
          <p className="text-sm text-amber-800">
            Admin approval is required before you can bid on or accept jobs.
          </p>
        </div>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="card grid gap-4">
          <h2 className="text-xl font-black">Available jobs</h2>
          {availableJobs.map((job) => {
            const existingOffer = job.offers[0];
            return (
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
                <p className="mt-2 text-sm">{job.description}</p>
                <p className="mt-2 text-xs text-slate-500">
                  Customer: {job.customer.customerProfile?.companyName ?? job.customer.email}
                </p>

                {profile?.status === "APPROVED" && job.type === JobType.BIDDING ? (
                  existingOffer ? (
                    <p className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">
                      Offer submitted: {formatCurrency(existingOffer.price)} · {existingOffer.status}
                    </p>
                  ) : (
                    <form action={submitOfferAction.bind(null, session.user.id)} className="mt-3 grid gap-2">
                      <input type="hidden" name="jobId" value={job.id} />
                      <label>
                        Offer price
                        <input name="price" type="number" min="1" step="0.01" defaultValue={job.budget.toString()} />
                      </label>
                      <label>
                        Message
                        <textarea name="message" required minLength={5} placeholder="Availability and scope notes" />
                      </label>
                      <button type="submit">Submit offer</button>
                    </form>
                  )
                ) : null}

                {profile?.status === "APPROVED" && job.type === JobType.BROADCAST && job.autoAssign ? (
                  <form action={acceptBroadcastAction.bind(null, session.user.id)} className="mt-3">
                    <input type="hidden" name="jobId" value={job.id} />
                    <button type="submit">Accept broadcast job</button>
                  </form>
                ) : null}
              </article>
            );
          })}
        </div>

        <div className="grid gap-4">
          <form action={withdrawAction.bind(null, session.user.id)} className="card grid gap-3">
            <h2 className="text-xl font-black">Withdraw</h2>
            <p className="text-sm text-slate-600">Simulated supplier withdrawal from available balance.</p>
            <label>
              Amount
              <input name="amount" type="number" min="1" step="0.01" required />
            </label>
            <button type="submit">Withdraw funds</button>
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
        <h2 className="text-xl font-black">Assigned jobs</h2>
        {assignedJobs.map((job) => (
          <article key={job.id} className="rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-black">{job.title}</h3>
                <p className="text-sm text-slate-600">
                  {job.category} · {job.location} · {formatCurrency(job.budget)}
                </p>
              </div>
              <StatusPill value={job.status} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {job.status === "ASSIGNED" ? (
                <form action={startJobAction.bind(null, session.user.id)}>
                  <input type="hidden" name="jobId" value={job.id} />
                  <button type="submit">Start job</button>
                </form>
              ) : null}
            </div>
            {["ASSIGNED", "IN_PROGRESS"].includes(job.status) ? (
              <form action={completeJobAction.bind(null, session.user.id)} className="mt-3 grid gap-2">
                <input type="hidden" name="jobId" value={job.id} />
                <label>
                  Completion notes
                  <textarea name="notes" required minLength={5} />
                </label>
                <label>
                  Photo URLs, one per line
                  <textarea name="photoUrls" placeholder="https://example.com/photo.jpg" />
                </label>
                <button type="submit">Mark complete</button>
              </form>
            ) : null}
          </article>
        ))}
      </section>

      <section className="card">
        <h2 className="mb-3 text-xl font-black">Withdrawal history</h2>
        <div className="grid gap-2">
          {wallet?.transactions
            .filter((transaction) => transaction.type === "WITHDRAWAL")
            .map((transaction) => (
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
