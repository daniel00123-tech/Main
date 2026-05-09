import { Role, SupplierStatus, TransactionStatus, TransactionType } from "@/generated/prisma/client";
import { StatCard } from "@/components/stat-card";
import { StatusPill } from "@/components/status-pill";
import { formatCurrency } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/rbac";
import { approveSupplierAction, rejectSupplierAction } from "@/app/admin/actions";

export default async function AdminPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  await requireRole([Role.ADMIN]);
  const params = await searchParams;
  const q = params.q?.trim();
  const status = params.status as SupplierStatus | undefined;

  const [users, suppliers, jobs, transactions] = await Promise.all([
    prisma.user.findMany({
      where: q
        ? {
            OR: [
              { email: { contains: q } },
              { name: { contains: q } },
              { customerProfile: { companyName: { contains: q } } },
              { supplierProfile: { businessName: { contains: q } } }
            ]
          }
        : undefined,
      include: { customerProfile: true, supplierProfile: true, wallet: true },
      orderBy: { createdAt: "desc" }
    }),
    prisma.supplierProfile.findMany({
      where: status ? { status } : undefined,
      include: { user: true },
      orderBy: { createdAt: "desc" }
    }),
    prisma.job.findMany({
      include: { customer: true, assignedSupplier: { include: { supplierProfile: true } }, offers: true },
      orderBy: { createdAt: "desc" }
    }),
    prisma.transaction.findMany({
      orderBy: { createdAt: "desc" },
      take: 50
    })
  ]);

  const totalFees = transactions
    .filter((transaction) => transaction.status === TransactionStatus.COMPLETED)
    .reduce((sum, transaction) => sum + Number(transaction.platformFee), 0);

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-3xl font-black">Admin panel</h1>
        <p className="text-slate-600">Manage users, supplier approvals, jobs, transactions, and platform fees.</p>
      </div>

      <div className="grid-auto">
        <StatCard label="Total users" value={users.length} />
        <StatCard label="Pending suppliers" value={suppliers.filter((s) => s.status === "PENDING").length} />
        <StatCard label="Active jobs" value={jobs.filter((j) => !["CLOSED", "CANCELLED"].includes(j.status)).length} />
        <StatCard label="Completed jobs" value={jobs.filter((j) => j.status === "CLOSED").length} />
        <StatCard label="Total fees earned" value={formatCurrency(totalFees)} />
      </div>

      <form className="card grid gap-3 md:grid-cols-[1fr_220px_auto]">
        <label>
          Search
          <input name="q" defaultValue={q} placeholder="Email, name, company" />
        </label>
        <label>
          Supplier status
          <select name="status" defaultValue={status ?? ""}>
            <option value="">All</option>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </label>
        <button className="self-end" type="submit">
          Filter
        </button>
      </form>

      <section className="card overflow-x-auto">
        <h2 className="mb-4 text-xl font-black">Supplier approvals</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2">Business</th>
              <th>Services</th>
              <th>Location</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((supplier) => (
              <tr key={supplier.id} className="border-b align-top">
                <td className="py-3">
                  <strong>{supplier.businessName}</strong>
                  <div className="text-slate-500">{supplier.user.email}</div>
                </td>
                <td>{Array.isArray(supplier.services) ? supplier.services.join(", ") : ""}</td>
                <td>{supplier.location}</td>
                <td>
                  <StatusPill value={supplier.status} />
                </td>
                <td className="flex gap-2 py-3">
                  <form action={approveSupplierAction}>
                    <input type="hidden" name="supplierUserId" value={supplier.userId} />
                    <button type="submit">Approve</button>
                  </form>
                  <form action={rejectSupplierAction}>
                    <input type="hidden" name="supplierUserId" value={supplier.userId} />
                    <button className="button-secondary" type="submit">
                      Reject
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-4 text-xl font-black">Jobs</h2>
          <div className="grid gap-3">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-xl border p-3">
                <div className="flex items-center justify-between gap-3">
                  <strong>{job.title}</strong>
                  <StatusPill value={job.status} />
                </div>
                <p className="text-sm text-slate-600">
                  {job.category} · {job.location} · {formatCurrency(job.budget)}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h2 className="mb-4 text-xl font-black">Transactions</h2>
          <div className="grid gap-3">
            {transactions.map((transaction) => (
              <div key={transaction.id} className="rounded-xl border p-3 text-sm">
                <div className="flex items-center justify-between">
                  <strong>{transaction.type}</strong>
                  <StatusPill value={transaction.status} />
                </div>
                <p>{formatCurrency(transaction.amount)}</p>
                {transaction.type === TransactionType.RELEASE ? (
                  <p className="text-slate-600">Platform fees: {formatCurrency(transaction.platformFee)}</p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
