import Link from "next/link";
import { listCases } from "@/lib/cases";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cases = await listCases();

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold mb-1">Teaching cases</h1>
      <p className="text-neutral-400 mb-8">
        Pick a case for a guided, voice-narrated tour — or author a new one.
      </p>

      {cases.length === 0 ? (
        <div className="rounded-lg border border-neutral-800 p-8 text-center text-neutral-400">
          No cases yet.{" "}
          <Link href="/author" className="text-yellow-400 hover:underline">
            Author your first case
          </Link>
          .
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {cases.map((c) => (
            <li key={c.caseId}>
              <Link
                href={`/case/${c.caseId}`}
                className="block rounded-lg border border-neutral-800 hover:border-yellow-500/50 p-4 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{c.title}</span>
                  <span className="text-xs rounded bg-neutral-800 px-2 py-0.5 text-neutral-300">
                    {c.modality}
                  </span>
                </div>
                <div className="mt-1 text-sm text-neutral-400">
                  {c.findings.length} finding{c.findings.length === 1 ? "" : "s"}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
