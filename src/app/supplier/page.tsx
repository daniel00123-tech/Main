import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { pounds } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { JOB_STATUS, JOB_TYPE, ROLE, SUPPLIER_STATUS } from "@/lib/types";
import { Button, Card, EmptyState, PageHeader, SectionTitle, StatCard, StatusBadge } from "@/components/ui";

export default async function SupplierDashboard() {
  const user = await getSessionUser();
  if (!user || user.role !== ROLE.SUPPLIER) redirect("/login");

  const [profile, wallet, availableJobs, assignedJobs, withdrawals] = await Promise.all([
    prisma.supplierProfile.findUnique({ where: { userId: user.id } }),
    prisma.wallet.findUnique({ where: { userId: user.id } }),
    prisma.job.findMany({
      where: {
        status: JOB_STATUS.OPEN,
        OR: [{ jobType: JOB_TYPE.BIDDING }, { jobType: JOB_TYPE.BROADCAST }],
      },
      include: { offers: { where: { supplierId: user.id } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.job.findMany({
      where: { supplierId: user.id },
      include: { customer: { include: { customerProfile: true } }, acceptedOffer: true },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.transaction.findMany({
      where: { userId: user.id, type: "SUPPLIER_WITHDRAWAL" },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  const isApproved = profile?.status === SUPPLIER_STATUS.APPROVED;

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <PageHeader
        eyebrow="Supplier dashboard"
        title={`Welcome, ${profile?.businessName ?? user.name}`}
        description="Browse open work, accept broadcast jobs, submit offers, and track earnings."
        actions={
          <form action="/api/auth/logout" method="post">
            <Button variant="secondary">Logout</Button>
          </form>
        }
      />

      <div className="mt-6 grid gap-4 md:grid-cols-4">
        <StatCard label="Profile status" value={<StatusBadge status={profile?.status ?? "PENDING"} />} />
        <StatCard label="Available balance" value={pounds(wallet?.balance ?? 0)} />
        <StatCard label="Pending earnings" value={pounds(wallet?.pendingBalance ?? 0)} />
        <StatCard label="Assigned jobs" value={assignedJobs.length} />
      </div>

      {!isApproved && (
        <Card className="mt-6 border-amber-200 bg-amber-50">
          <h2 className="font-semibold text-amber-950">Admin approval required</h2>
          <p className="mt-2 text-sm text-amber-900">
            Suppliers can view the dashboard immediately, but offers and instant accepts are restricted until approval.
          </p>
        </Card>
      )}

      <section className="mt-8">
        <SectionTitle title="Open marketplace and broadcast jobs" />
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {availableJobs.length === 0 && <EmptyState title="No available jobs" description="New jobs will appear here when customers post them." />}
          {availableJobs.map((job) => (
            <Card key={job.id}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold">{job.title}</h3>
                  <p className="mt-1 text-sm text-slate-600">{job.description}</p>
                </div>
                <StatusBadge status={job.jobType} />
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm text-slate-600">
                <div>
                  <dt className="font-medium text-slate-900">Category</dt>
                  <dd>{job.category}</dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-900">Budget</dt>
                  <dd>{pounds(job.budget)}</dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-900">Location</dt>
                  <dd>{job.location}</dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-900">Your offer</dt>
                  <dd>{job.offers[0] ? pounds(job.offers[0].price) : "None"}</dd>
                </div>
              </dl>
              {isApproved && (
                <div className="mt-4 flex flex-col gap-3">
                  {job.jobType === JOB_TYPE.BROADCAST && job.firstSupplierCanAccept && !job.offers[0] && (
                    <form action={`/api/jobs/${job.id}/accept`} method="post">
                      <Button type="submit">Accept instantly</Button>
                    </form>
                  )}
                  {!job.offers[0] && (
                    <form action={`/api/jobs/${job.id}/offers`} method="post" className="grid gap-2">
                      <input name="price" type="number" min="1" placeholder="Offer price in GBP" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
                      <textarea name="message" placeholder="Message to customer" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
                      <Button type="submit" variant="secondary">Submit offer</Button>
                    </form>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <SectionTitle title="Assigned jobs" />
        <div className="mt-4 grid gap-4">
          {assignedJobs.length === 0 && <EmptyState title="No assigned jobs" description="Accepted jobs will appear here." />}
          {assignedJobs.map((job) => (
            <Card key={job.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{job.title}</h3>
                  <p className="text-sm text-slate-600">{job.customer.customerProfile?.companyName} - {job.location}</p>
                </div>
                <StatusBadge status={job.status} />
              </div>
              <div className="mt-4 flex flex-wrap gap-3">
                {job.status === JOB_STATUS.ASSIGNED && (
                  <form action={`/api/jobs/${job.id}/start`} method="post">
                    <Button variant="secondary">Start job</Button>
                  </form>
                )}
                {[JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS].includes(job.status) && (
                  <form action={`/api/jobs/${job.id}/complete`} method="post" className="grid flex-1 gap-2 md:grid-cols-[1fr_1fr_auto]">
                    <textarea name="notes" placeholder="Completion notes" className="rounded-lg border border-slate-300 px-3 py-2 text-sm md:col-span-1" required />
                    <input name="photoUrls" placeholder="Photo URLs, comma-separated" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    <Button>Mark complete</Button>
                  </form>
                )}
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <SectionTitle title="Withdrawals" />
        <Card className="mt-4">
          <form action="/api/wallet/withdraw" method="post" className="flex flex-wrap gap-3">
            <input name="amount" type="number" min="1" placeholder="Amount in GBP" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
            <Button>Withdraw</Button>
          </form>
          <div className="mt-4 space-y-2 text-sm">
            {withdrawals.map((transaction) => (
              <div key={transaction.id} className="flex justify-between rounded-lg bg-slate-50 px-3 py-2">
                <span>{transaction.createdAt.toLocaleDateString()}</span>
                <span>{pounds(transaction.amount)}</span>
              </div>
            ))}
          </div>
        </Card>
      </section>
    </main>
  );
}
