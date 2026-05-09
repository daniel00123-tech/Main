import { Suspense } from "react";
import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-4 text-3xl font-black">Log in</h1>
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
