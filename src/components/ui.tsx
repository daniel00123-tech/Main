import Link from "next/link";
import type { ReactNode } from "react";
import { formatPounds } from "@/lib/money";
import type { SessionUser } from "@/lib/types";

export function PageShell({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-6 py-8">{children}</main>;
}

export function Card({ children, className = "", title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-6 shadow-sm ${className}`}>
      {title ? <h2 className="mb-4 text-xl font-semibold text-slate-950">{title}</h2> : null}
      {children}
    </section>
  );
}

export function Shell({ children, user }: { children: ReactNode; user?: SessionUser }) {
  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-8">
      {user ? <p className="mb-4 text-sm text-slate-500">Signed in as {user.name} ({user.role.toLowerCase()})</p> : null}
      {children}
    </main>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div>
        {eyebrow ? <p className="text-sm font-semibold uppercase tracking-wide text-blue-700">{eyebrow}</p> : null}
        <h1 className="text-3xl font-bold text-slate-950">{title}</h1>
        {description ? <p className="mt-2 max-w-3xl text-slate-600">{description}</p> : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
    </div>
  );
}

export function StatCard({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card>
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-slate-950">{value}</p>
    </Card>
  );
}

export const MetricCard = StatCard;

export function StatusBadge({ status }: { status: string }) {
  return <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700">{status.replaceAll("_", " ")}</span>;
}

export function Badge({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-700">{children}</span>;
}

export function EmptyState({ title = "Nothing here yet", description, message }: { title?: string; description?: string; message?: string }) {
  return <div className="rounded-2xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">{description ?? message ?? title}</div>;
}

export function Button({
  children,
  variant = "primary",
  type = "submit",
}: {
  children: ReactNode;
  variant?: "primary" | "secondary";
  type?: "button" | "submit" | "reset";
}) {
  const className =
    variant === "primary"
      ? "rounded-xl bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
      : "rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50";
  return (
    <button type={type} className={className}>
      {children}
    </button>
  );
}

export function Money({ value }: { value: number }) {
  return <>{formatPounds(value)}</>;
}

export function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link className="inline-flex rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800" href={href}>
      {children}
    </Link>
  );
}
