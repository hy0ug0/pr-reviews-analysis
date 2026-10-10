// Progress for a step that works on several repos at once. Each repo reports its own entry;
// every report publishes the whole list, in the order the entries were given at the start,
// so each snapshot is complete however the repos interleave.
export function createRepoProgress<Entry extends { repo: string }>({
  entries,
  publish,
}: {
  entries: Entry[];
  publish: (entries: Entry[]) => void;
}): (entry: Entry) => void {
  // A Map keeps the first insertion's position when a key is set again.
  const byRepo = new Map(entries.map((entry) => [entry.repo, entry]));
  return (entry) => {
    if (!byRepo.has(entry.repo)) throw new Error(`No progress entry for ${entry.repo}.`);
    byRepo.set(entry.repo, entry);
    publish(Array.from(byRepo.values()));
  };
}
