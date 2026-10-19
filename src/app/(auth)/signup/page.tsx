import Link from "next/link";
import { SignupForm } from "@/components/auth/signup-form";
import { safeRedirectPath } from "@/server/auth/schema";

export const metadata = { title: "Create account · OneForAll" };

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const params = await searchParams;
  // Same-origin path only (open-redirect safe); used to return to an invitation after creating the account.
  const next = typeof params.next === "string" ? safeRedirectPath(params.next) : undefined;
  return (
    <div className="flex flex-col gap-7">
      <div>
        <h1 className="t-h1 text-fg">Create your account</h1>
        <p className="t-body mt-1.5 text-fg-2">Set up your OneForAll workspace in a minute.</p>
      </div>
      <SignupForm next={next} />
      <p className="t-small text-fg-3">
        Already have an account?{" "}
        <Link href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"} className="font-medium text-accent hover:text-fg">
          Sign in
        </Link>
      </p>
    </div>
  );
}
