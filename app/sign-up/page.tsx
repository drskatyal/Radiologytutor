import Link from "next/link";
import { AuthForm } from "@/components/auth/AuthForm";
import { BrandMark } from "@/components/AppShell";
import { googleAuthEnabled } from "@/lib/auth";
import { Card, PageContainer } from "@/components/ui";

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
    <PageContainer className="flex min-h-[70vh] flex-col items-center justify-center py-12">
      <Link href="/" className="mb-8 flex items-center gap-2.5">
        <BrandMark />
        <span className="font-display text-lg font-semibold tracking-tight text-primary">
          FlowRad <span className="text-accent">Learn</span>
        </span>
      </Link>
      <Card className="w-full max-w-sm">
        <AuthForm mode="sign-up" googleEnabled={googleAuthEnabled()} next={next} />
      </Card>
    </PageContainer>
  );
}
