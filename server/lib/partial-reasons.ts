// Caps a list of partial fetch reasons so the response stays readable.
export function uniqueReasons(reasons: string[]): string[] {
  const unique = Array.from(new Set(reasons.filter(Boolean)));
  if (unique.length <= 5) return unique;
  const omitted = unique.length - 4;
  return [...unique.slice(0, 4), `${omitted} additional partial fetch issue(s) omitted.`];
}
