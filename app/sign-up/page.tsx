import Link from "next/link";
import { AuthForm } from "@/components/auth/AuthForm";
import { BrandMark, Wordmark } from "@/components/brand/BrandMark";
import { googleAuthEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Create account · FlowRad Learn",
};

export default function SignUpPage({
  searchParams,
}: {
  searchParams?: { next?: string };
}) {
  const next = searchParams?.next?.startsWith("/") ? searchParams.next : "/dashboard";
  return (
    <div className="relative flex min-h-[calc(100vh-0px)] flex-col items-center justify-center px-6 py-16">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 bg-imaging" />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: [
              "radial-gradient(ellipse 55% 40% at 50% 28%, rgb(70 75 82 / 0.35), transparent 60%)",
              "linear-gradient(180deg, rgb(0 0 0) 0%, rgb(14 13 12) 100%)",
            ].join(", "),
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-canvas to-transparent" />
      </div>
      <div className="relative z-10 w-full max-w-sm">
        <Link href="/" className="mb-10 flex items-center justify-center gap-3">
          <BrandMark size="lg" />
          <Wordmark size="lg" />
        </Link>
        <div className="border-y border-subtle bg-surface/80 px-1 py-8 backdrop-blur-sm sm:px-2">
          <AuthForm mode="sign-up" googleEnabled={googleAuthEnabled()} next={next} />
        </div>
      </div>
    </div>
  );
}
