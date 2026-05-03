import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { JOB_CATEGORIES } from "@/lib/types";

export default async function SignupPage() {
  const user = await getSessionUser();
  if (user) {
    redirect(`/${user.role.toLowerCase()}`);
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-blue-700">Create account</p>
        <h1 className="mt-2 text-3xl font-bold text-slate-950">Join the marketplace</h1>
        <p className="mt-3 text-slate-600">Choose the role that matches how you will use the platform.</p>
      </div>

      <form action="/api/auth/register" method="post" className="grid gap-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="rounded-2xl border border-slate-200 p-4">
            <input type="radio" name="role" value="CUSTOMER" defaultChecked className="mr-2" />
            Customer / FM company
          </label>
          <label className="rounded-2xl border border-slate-200 p-4">
            <input type="radio" name="role" value="SUPPLIER" className="mr-2" />
            Supplier / subcontractor
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <input className="rounded-xl border border-slate-300 px-4 py-3" name="name" placeholder="Name or contact name" required />
          <input className="rounded-xl border border-slate-300 px-4 py-3" name="email" type="email" placeholder="Email" required />
          <input className="rounded-xl border border-slate-300 px-4 py-3" name="phone" placeholder="Phone" />
          <input className="rounded-xl border border-slate-300 px-4 py-3" name="password" type="password" placeholder="Password" minLength={8} required />
        </div>

        <section className="grid gap-4 rounded-2xl bg-slate-50 p-4 md:grid-cols-2">
          <input className="rounded-xl border border-slate-300 px-4 py-3" name="companyName" placeholder="Customer company name" />
          <input className="rounded-xl border border-slate-300 px-4 py-3" name="location" placeholder="Customer location" />
        </section>

        <section className="grid gap-4 rounded-2xl bg-slate-50 p-4 md:grid-cols-2">
          <input className="rounded-xl border border-slate-300 px-4 py-3" name="businessName" placeholder="Supplier business name" />
          <input className="rounded-xl border border-slate-300 px-4 py-3" name="contactName" placeholder="Supplier contact name" />
          <input className="rounded-xl border border-slate-300 px-4 py-3" name="location" placeholder="Supplier location" />
          <input className="rounded-xl border border-slate-300 px-4 py-3" name="rateAmount" type="number" min="1" placeholder="Rate in pence" />
          <select className="rounded-xl border border-slate-300 px-4 py-3" name="rateType">
            <option value="hourly">Hourly</option>
            <option value="fixed">Fixed</option>
          </select>
          <input className="rounded-xl border border-slate-300 px-4 py-3" name="availability" placeholder="Availability" />
          <textarea className="rounded-xl border border-slate-300 px-4 py-3 md:col-span-2" name="description" placeholder="Supplier description" />
          <div className="md:col-span-2">
            <p className="mb-2 text-sm font-semibold text-slate-700">Services</p>
            <div className="flex flex-wrap gap-3">
              {JOB_CATEGORIES.map((service) => (
                <label key={service} className="rounded-full border border-slate-300 px-3 py-1 text-sm">
                  <input type="checkbox" name="services" value={service} className="mr-2" />
                  {service}
                </label>
              ))}
            </div>
          </div>
        </section>

        <button className="rounded-xl bg-blue-700 px-5 py-3 font-semibold text-white" type="submit">
          Create account
        </button>
      </form>
    </main>
  );
}
