import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Card, EmptyState, MetricCard, PageHeader, Shell } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getAdminMetrics } from "@/lib/dashboard";
import { formatCurrency } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { ROLE, SUPPLIER_STATUS } from "@/lib/types";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; supplierStatus?: string }>;
}) {
  const user = await requireUser([ROLE.ADMIN]);
  const params = await searchParams;
  const metrics = await getAdminMetrics();
  const query = params.q?.trim();

  const [users, suppliers, jobs, transactions] = await Promise.all([
    prisma.user.findMany({
      where: query
        ? {
            OR: [
              { email: { contains: query } },
              { name: { contains: query } },
              { customerProfile: { companyName: { contains: query } } },
              { supplierProfile: { businessName: { contains: query } } },
            ],
          }
        : undefined,
      include: { wallet: true, customerProfile: true, supplierProfile: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.supplierProfile.findMany({
      where: params.supplierStatus ? { status: params.supplierStatus } : undefined,
      include: { user: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.job.findMany({ include: { customer: true, supplier: true }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.transaction.findMany({ include: { user: true, job: true }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);

  if (user.role !== ROLE.ADMIN) redirect("/dashboard");

  return (
    <Shell user={user}>
      <PageHeader title="Admin control panel" description="Approve suppliers, inspect jobs, and monitor simulated marketplace revenue." />

      <section className="grid gap-4 md:grid-cols-5">
        <MetricCard label="Total users" value={metrics.totalUsers} />
        <MetricCard label="Pending suppliers" value={metrics.pendingSuppliers} />
        <MetricCard label="Active jobs" value={metrics.activeJobs} />
        <MetricCard label="Closed jobs" value={metrics.completedJobs} />
        <MetricCard label="Fees earned" value={formatCurrency(metrics.totalFees)} />
      </section>

      <Card>
        <form className="grid gap-3 md:grid-cols-[1fr_220px_auto]">
          <input name="q" defaultValue={params.q ?? ""} placeholder="Search users, companies, emails" className="rounded-xl border px-3 py-2" />
          <select name="supplierStatus" defaultValue={params.supplierStatus ?? ""} className="rounded-xl border px-3 py-2">
            <option value="">All supplier statuses</option>
            {Object.values(SUPPLIER_STATUS).map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <button className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white">Filter</button>
        </form>
      </Card>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card title="Users">
          <div className="space-y-3">
            {users.map((item) => (
              <div key={item.id} className="rounded-2xl border p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold">{item.name}</p>
                    <p className="text-sm text-slate-500">{item.email}</p>
                  </div>
                  <Badge>{item.role}</Badge>
                </div>
                <p className="mt-2 text-sm text-slate-600">
                  Wallet {formatCurrency(item.wallet?.balance ?? 0)} available, {formatCurrency(item.wallet?.pendingBalance ?? 0)} pending
                </p>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Supplier approvals">
          <div className="space-y-3">
            {suppliers.length === 0 ? <EmptyState message="No suppliers match this filter." /> : null}
            {suppliers.map((supplier) => (
              <div key={supplier.id} className="rounded-2xl border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{supplier.businessName}</p>
                    <p className="text-sm text-slate-500">
                      {supplier.contactName} - {supplier.location}
                    </p>
                    <p className="mt-2 text-sm text-slate-600">{supplier.description}</p>
                    <p className="mt-1 text-xs uppercase tracking-wide text-slate-400">{JSON.parse(supplier.services).join(", ")}</p>
                  </div>
                  <Badge>{supplier.status}</Badge>
                </div>
                <div className="mt-4 flex gap-2">
                  <form action={`/api/admin/suppliers/${supplier.userId}/status`} method="post">
                    <input type="hidden" name="status" value={SUPPLIER_STATUS.APPROVED} />
                    <button className="rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white">Approve</button>
                  </form>
                  <form action={`/api/admin/suppliers/${supplier.userId}/status`} method="post">
                    <input type="hidden" name="status" value={SUPPLIER_STATUS.REJECTED} />
                    <button className="rounded-xl bg-rose-600 px-3 py-2 text-sm font-semibold text-white">Reject</button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card title="Jobs">
          <div className="space-y-3">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-2xl border p-4">
                <div className="flex justify-between gap-3">
                  <div>
                    <p className="font-semibold">{job.title}</p>
                    <p className="text-sm text-slate-500">
                      {job.customer.name} {job.supplier ? `-> ${job.supplier.name}` : ""}
                    </p>
                  </div>
                  <Badge>{job.status}</Badge>
                </div>
                <p className="mt-2 text-sm">{formatCurrency(job.budget)} - {job.category} - {job.jobType}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Transactions">
          <div className="space-y-3">
            {transactions.map((transaction) => (
              <div key={transaction.id} className="rounded-2xl border p-4">
                <div className="flex justify-between gap-3">
                  <div>
                    <p className="font-semibold">{transaction.type}</p>
                    <p className="text-sm text-slate-500">{transaction.user.email}</p>
                  </div>
                  <Badge>{transaction.status}</Badge>
                </div>
                <p className="mt-2 text-sm">
                  {formatCurrency(transaction.amount)} fee {formatCurrency(transaction.feeAmount)}
                </p>
              </div>
            ))}
          </div>
          <Link href="/api/jobs/auto-release" className="mt-4 inline-block text-sm font-semibold text-slate-700">
            Auto-release endpoint: POST /api/jobs/auto-release
          </Link>
        </Card>
      </section>
    </Shell>
  );
}
