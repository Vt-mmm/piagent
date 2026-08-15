export type TextDiffOperation = { kind: "context" | "added" | "deleted"; text: string };

export type TextDiffResult = {
  operations: TextDiffOperation[];
  additions: number;
  deletions: number;
  exact: boolean;
  reasonCode: string | null;
};

function lines(content: Buffer): string[] | null {
  if (content.includes(0)) return null;
  const text = content.toString("utf8");
  if (Buffer.from(text, "utf8").compare(content) !== 0) return null;
  if (!text) return [];
  const result = text.split("\n");
  if (text.endsWith("\n")) result.pop();
  return result.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

export function diffTextBuffers(base: Buffer, current: Buffer, maxCells = 4_000_000): TextDiffResult {
  const before = lines(base);
  const after = lines(current);
  if (!before || !after) return { operations: [], additions: 0, deletions: 0, exact: false, reasonCode: "binary-content" };
  const cells = (before.length + 1) * (after.length + 1);
  if (!Number.isSafeInteger(cells) || cells > maxCells) {
    return { operations: [], additions: 0, deletions: 0, exact: false, reasonCode: "diff-complexity-limit" };
  }
  const matrix = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      matrix[left][right] = before[left] === after[right]
        ? matrix[left + 1][right + 1] + 1
        : Math.max(matrix[left + 1][right], matrix[left][right + 1]);
    }
  }
  const operations: TextDiffOperation[] = [];
  let left = 0;
  let right = 0;
  let additions = 0;
  let deletions = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      operations.push({ kind: "context", text: before[left] });
      left += 1;
      right += 1;
    } else if (right < after.length && (left >= before.length || matrix[left][right + 1] >= matrix[left + 1][right])) {
      operations.push({ kind: "added", text: after[right++] });
      additions += 1;
    } else {
      operations.push({ kind: "deleted", text: before[left++] });
      deletions += 1;
    }
  }
  return { operations, additions, deletions, exact: true, reasonCode: null };
}

export function buffersEqual(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}
