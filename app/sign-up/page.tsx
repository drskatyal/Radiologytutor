import { AuthForm } from "@/components/auth/AuthForm";
import { googleAuthEnabled } from "@/lib/auth";
import { PageContainer } from "@/components/ui";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return (
    <PageContainer className="flex min-h-[70vh] items-center justify-center py-12">
      <AuthForm mode="sign-up" googleEnabled={googleAuthEnabled()} />
    </PageContainer>
  );
}
