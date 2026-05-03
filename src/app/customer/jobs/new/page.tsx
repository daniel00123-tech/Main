import { redirect } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { JOB_CATEGORIES, ROLE } from "@/lib/types";

export default async function NewJobPage() {
  const user = await getSessionUser();
  if (!user || user.role !== ROLE.CUSTOMER) redirect("/login");

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader title="Post a job" description="Create either an open bidding job or a broadcast job matched to suppliers by category and location." />
      <Card>
        <form action="/api/jobs" method="post" className="grid gap-4">
          <input name="title" placeholder="Job title" className="rounded-xl border border-slate-300 px-4 py-3" required />
          <textarea name="description" placeholder="Detailed description" className="min-h-32 rounded-xl border border-slate-300 px-4 py-3" required />
          <div className="grid gap-4 md:grid-cols-2">
            <select name="category" className="rounded-xl border border-slate-300 px-4 py-3">
              {JOB_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
            <input name="location" placeholder="Location" className="rounded-xl border border-slate-300 px-4 py-3" required />
            <input name="budget" type="number" min="1" step="0.01" placeholder="Budget in GBP" className="rounded-xl border border-slate-300 px-4 py-3" required />
            <input name="deadline" type="datetime-local" className="rounded-xl border border-slate-300 px-4 py-3" required />
            <select name="jobType" className="rounded-xl border border-slate-300 px-4 py-3">
              <option value="BIDDING">Open marketplace bidding</option>
              <option value="BROADCAST">Broadcast to matching suppliers</option>
            </select>
            <label className="flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-3 text-sm">
              <input type="checkbox" name="firstSupplierCanAccept" />
              First matching supplier can accept instantly
            </label>
          </div>
          <button className="rounded-xl bg-blue-700 px-5 py-3 font-semibold text-white">Post job</button>
        </form>
      </Card>
    </main>
  );
}
