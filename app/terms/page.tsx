import Link from "next/link";

export const metadata = {
  title: "Terms · RadLearn",
  description: "Terms for using RadLearn to record and replay radiology teaching.",
};

export default function TermsPage() {
  return (
    <article className="mx-auto max-w-[680px] px-4 py-16 sm:px-8">
      <p className="text-sm text-secondary">
        <Link href="/" className="font-semibold text-primary hover:text-secondary">
          Home
        </Link>
      </p>
      <h1 className="mt-6 text-4xl font-semibold tracking-tight text-balance">Terms</h1>
      <div className="mt-8 flex flex-col gap-6 text-base text-secondary text-pretty">
        <p>
          RadLearn lets a teacher record a read on a DICOM study and lets a learner replay that
          teach with a tutor. It is not a medical device and it does not produce a diagnostic report.
        </p>
        <p>
          You are responsible for the studies you upload. Use only imaging you have the right to
          teach from, and only imaging that has already been anonymised.
        </p>
        <p>
          Creating a teacher account is free. No card is required. You may stop using RadLearn at
          any time. Published cases stay in your organisation until you unpublish or delete them.
        </p>
        <p>
          Do not use the tutor output as a clinical opinion. The tutor repeats the teaching path
          and the case context the author provided.
        </p>
      </div>
    </article>
  );
}
