export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
}

/** Pretty-print then line-diff two JSON values (LCS). Small inputs only (trace payloads); not a general diff. */
export const diffJson = (before: unknown, after: unknown): DiffLine[] => {
  const a = JSON.stringify(before, null, 2)?.split('\n') ?? [];
  const b = JSON.stringify(after, null, 2)?.split('\n') ?? [];
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array.from<number>({ length: b.length + 1 }).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'remove', text: a[i++] });
    } else {
      out.push({ kind: 'add', text: b[j++] });
    }
  }
  while (i < a.length) {
    out.push({ kind: 'remove', text: a[i++] });
  }
  while (j < b.length) {
    out.push({ kind: 'add', text: b[j++] });
  }
  return out;
};

export const hasChanges = (lines: DiffLine[]) => lines.some(l => l.kind !== 'same');
