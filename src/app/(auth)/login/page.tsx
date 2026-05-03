import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-6">
      <div className="card w-full space-y-6">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-500">Login</p>
          <h1 className="mt-2 text-3xl font-bold text-slate-950">Welcome back</h1>
        </div>
        <form action="/api/auth/login" method="post" className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            Email
            <input name="email" type="email" required className="input mt-1" />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Password
            <input name="password" type="password" required className="input mt-1" />
          </label>
          <button className="btn-primary w-full" type="submit">
            Sign in
          </button>
        </form>
        <p className="text-sm text-slate-600">
          Need an account?{" "}
          <Link className="font-semibold text-slate-950" href="/signup">
            Sign up
          </Link>
        </p>
      </div>
    </main>
  );
}
