import { AuthForm } from "@/components/auth/AuthForm";
import { googleAuthEnabled } from "@/lib/auth";
import { PageContainer } from "@/components/ui";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <PageContainer className="flex min-h-[70vh] items-center justify-center py-12">
      <AuthForm mode="sign-in" googleEnabled={googleAuthEnabled()} />
    </PageContainer>
  );
}
