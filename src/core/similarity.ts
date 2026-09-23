/** Edit distance between two strings (insertions, deletions, substitutions). */
export function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + cost;
      current[j] = Math.min(deletion, insertion, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** The candidate closest to `input`, or undefined if none is close enough to be a likely typo. */
export function suggest(input: string, candidates: Iterable<string>): string | undefined {
  const target = input.toLowerCase();
  const limit = Math.max(1, Math.min(3, Math.floor(input.length / 3)));
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(target, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= limit ? best : undefined;
}
