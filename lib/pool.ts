// ============================================================================
// lib/pool.ts  (client + server)
//
// Run an async step over items with at most `limit` in flight. Used where a
// serial `for … await` made the study upload one round trip at a time
// (components/cases/DicomDropzone.tsx batches, lib/uploadIngest.ts stores).
// Each item's step must handle its own errors; the first throw stops new work
// and rejects once the in-flight steps settle.
// ============================================================================

export async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  step: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && !shouldStop() && next < items.length) {
      const index = next++;
      try {
        await step(items[index]!, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}
