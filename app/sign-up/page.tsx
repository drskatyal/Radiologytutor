import Link from "next/link";
import { AuthForm } from "@/components/auth/AuthForm";
import { BrandMark, Wordmark } from "@/components/brand/BrandMark";
import { demoAuthEnabled, googleAuthEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Create account · RadLearn",
};

export default function SignUpPage({
  searchParams,
}: {
  searchParams?: { next?: string };
}) {
  const next =
    searchParams?.next?.startsWith("/") && !searchParams.next.startsWith("//")
      ? searchParams.next
      : "/dashboard";
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-16">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <BrandMark size="lg" />
          <Wordmark size="lg" />
        </Link>
        <div className="rounded-2xl bg-surface p-6">
          <AuthForm
            mode="sign-up"
            googleEnabled={googleAuthEnabled()}
            demoEnabled={demoAuthEnabled()}
            next={next}
          />
        </div>
        <p className="mt-6 text-center text-sm text-secondary">
          <Link href="/privacy" className="font-semibold hover:text-primary">
            Privacy
          </Link>
          <span className="px-2" aria-hidden="true">
            ·
          </span>
          <Link href="/terms" className="font-semibold hover:text-primary">
            Terms
          </Link>
        </p>
      </div>
    </div>
  );
}
