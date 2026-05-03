import { prisma } from "@/lib/prisma";
import { JOB_STATUS, ROLE, SUPPLIER_STATUS, TRANSACTION_STATUS, TRANSACTION_TYPE } from "@/lib/types";

export async function getDashboardRedirect(role: string) {
  if (role === ROLE.ADMIN) return "/admin";
  if (role === ROLE.CUSTOMER) return "/customer";
  return "/supplier";
}

export async function getAdminMetrics() {
  const [totalUsers, pendingSuppliers, activeJobs, completedJobs, fees] = await Promise.all([
    prisma.user.count(),
    prisma.supplierProfile.count({ where: { status: SUPPLIER_STATUS.PENDING } }),
    prisma.job.count({ where: { status: { in: [JOB_STATUS.OPEN, JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL] } } }),
    prisma.job.count({ where: { status: JOB_STATUS.CLOSED } }),
    prisma.transaction.aggregate({
      where: { type: TRANSACTION_TYPE.PLATFORM_FEE, status: TRANSACTION_STATUS.SUCCEEDED },
      _sum: { amount: true },
    }),
  ]);

  return {
    totalUsers,
    pendingSuppliers,
    activeJobs,
    completedJobs,
    totalFees: fees._sum.amount ?? 0,
  };
}
