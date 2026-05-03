import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Card, EmptyState, Money, PageHeader, SectionTitle, StatCard } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { JOB_STATUS, ROLE } from "@/lib/types";

export default async function CustomerDashboard() {
  const user = await getSessionUser();
  if (!user || user.role !== ROLE.CUSTOMER) redirect("/login");

  const [wallet, jobs, offersReceived, assignedJobs, transactions] = await Promise.all([
    prisma.wallet.findUnique({ where: { userId: user.id } }),
    prisma.job.findMany({
      where: { customerId: user.id },
      include: { offers: { include: { supplier: { include: { supplierProfile: true } } } }, supplier: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.offer.count({ where: { job: { customerId: user.id } } }),
    prisma.job.count({ where: { customerId: user.id, status: { in: [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL] } } }),
    prisma.walletTransaction.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 8 }),
  ]);

  return (
    <main className="space-y-8">
      <PageHeader
        title="Customer dashboard"
        description="Post jobs, review offers, assign suppliers, and manage simulated funds."
        actions={
          <Link className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white" href="/customer/jobs/new">
            Post a job
          </Link>
        }
      />

      <section className="grid gap-4 md:grid-cols-4">
        <StatCard label="Jobs posted" value={jobs.length} />
        <StatCard label="Offers received" value={offersReceived} />
        <StatCard label="Assigned jobs" value={assignedJobs} />
        <StatCard label="Wallet balance" value={<Money value={wallet?.balance ?? 0} />} />
      </section>

      <Card>
        <SectionTitle title="Fund wallet" description="Simulated top-up for reserving job payments." />
        <form action="/api/wallet/fund" method="post" className="flex gap-3">
          <input name="amount" type="number" min="1" step="0.01" placeholder="Amount in GBP" className="input" />
          <button className="btn-primary">Add funds</button>
        </form>
      </Card>

      <Card>
        <SectionTitle title="Your jobs" description="Review offers and lifecycle actions." />
        <div className="space-y-4">
          {jobs.length === 0 ? <EmptyState title="No jobs yet" description="Create your first maintenance job." /> : null}
          {jobs.map((job) => (
            <div key={job.id} className="rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-950">{job.title}</h3>
                  <p className="text-sm text-slate-600">{job.category} in {job.location}</p>
                </div>
                <div className="flex gap-2">
                  <Badge>{job.jobType}</Badge>
                  <Badge>{job.status}</Badge>
                </div>
              </div>
              <p className="mt-3 text-sm text-slate-700">{job.description}</p>
              <p className="mt-2 text-sm font-medium"><Money value={job.budget} /> budget</p>

              {job.offers.length > 0 ? (
                <div className="mt-4 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Offers</p>
                  {job.offers.map((offer) => (
                    <div key={offer.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-3 text-sm">
                      <div>
                        <p className="font-medium">{offer.supplier.supplierProfile?.businessName ?? offer.supplier.name}</p>
                        <p className="text-slate-600">{offer.message}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <Money value={offer.price} />
                        <Badge>{offer.status}</Badge>
                        {job.status === JOB_STATUS.OPEN ? (
                          <form action={`/api/offers/${offer.id}/accept`} method="post">
                            <button className="btn-secondary">Accept</button>
                          </form>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              {job.status === JOB_STATUS.AWAITING_APPROVAL ? (
                <div className="mt-4 flex gap-3">
                  <form action={`/api/jobs/${job.id}/approve`} method="post">
                    <button className="btn-primary">Approve and release</button>
                  </form>
                  <form action={`/api/jobs/${job.id}/dispute`} method="post">
                    <button className="btn-danger">Dispute</button>
                  </form>
                  <form action={`/api/jobs/${job.id}`} method="post">
                    <input type="hidden" name="_method" value="DELETE" />
                    <button className="btn-secondary">Cancel</button>
                  </form>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle title="Payment history" />
        <div className="space-y-2">
          {transactions.map((entry) => (
            <div key={entry.id} className="flex justify-between rounded-xl bg-slate-50 p-3 text-sm">
              <span>{entry.description}</span>
              <Money value={entry.amount} />
            </div>
          ))}
        </div>
      </Card>
    </main>
  );
}
