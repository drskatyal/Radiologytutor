import Link from "next/link";

export const metadata = {
  title: "Privacy · RadLearn",
  description: "How RadLearn handles your account, your studies, and session cookies.",
};

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-[680px] px-4 py-16 sm:px-8">
      <p className="text-sm text-secondary">
        <Link href="/" className="font-semibold text-primary hover:text-secondary">
          Home
        </Link>
      </p>
      <h1 className="mt-6 text-4xl font-semibold tracking-tight text-balance">Privacy</h1>
      <div className="mt-8 flex flex-col gap-6 text-base text-secondary text-pretty">
        <p>
          RadLearn is a teaching product. An account stores your name, email, and the role you hold
          in an organisation. A session cookie keeps you signed in. We do not run advertising cookies.
        </p>
        <p>
          Studies you upload are used to teach on the viewer. Upload only imaging you are allowed to
          use. When a teacher uploads a study, patient names, IDs, and dates of birth are removed
          from the DICOM headers before the images are stored. Text burned into the pixels is not
          detected.
        </p>
        <p>
          Narration you record is stored so the tutor can replay the teach. It is not sold, and it
          is not used to make a clinical diagnosis.
        </p>
        <p>
          To ask for a copy of your account data, or to ask us to delete it, write to the address
          on your invitation. We will confirm what we removed.
        </p>
      </div>
    </article>
  );
}
