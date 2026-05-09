// Parse page-range strings like "1-20", "1,3,5-8", "  2 ,  4 - 6 ".
// Returns a sorted, deduplicated array of 1-based page numbers.
// Throws on syntax errors. Caller validates against the actual PDF length.

export function parsePageRange(input) {
  if (input == null) return [];
  const text = String(input).trim();
  if (!text) return [];

  const result = new Set();
  const parts = text.split(',');
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.includes('-')) {
      const [aStr, bStr, ...rest] = part.split('-').map((s) => s.trim());
      if (rest.length > 0) throw new Error(`Invalid range: "${part}"`);
      const a = toInt(aStr, part);
      const b = toInt(bStr, part);
      if (a > b) throw new Error(`Range start > end: "${part}"`);
      for (let n = a; n <= b; n++) result.add(n);
    } else {
      result.add(toInt(part, part));
    }
  }
  return [...result].sort((x, y) => x - y);
}

function toInt(s, original) {
  if (!/^\d+$/.test(s)) throw new Error(`Not a positive integer: "${original}"`);
  const n = parseInt(s, 10);
  if (n < 1) throw new Error(`Page numbers must be 1 or greater: "${original}"`);
  return n;
}

export function validateRanges({ questionPages, answerPages, totalPages }) {
  const issues = [];
  for (const p of questionPages) {
    if (p > totalPages) issues.push(`Question page ${p} is past end of PDF (${totalPages})`);
  }
  for (const p of answerPages) {
    if (p > totalPages) issues.push(`Answer page ${p} is past end of PDF (${totalPages})`);
  }
  if (questionPages.length === 0) issues.push('No question pages selected');
  return issues;
}

export function rangesOverlap(a, b) {
  const setA = new Set(a);
  for (const v of b) if (setA.has(v)) return true;
  return false;
}
