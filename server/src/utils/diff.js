/**
 * Minimal unified-diff generator (File Collaboration, FC-02)
 *
 * Produces a compact, line-based unified diff between two UTF-8 strings for the
 * file-revision log — no external dependency. The output feeds both the change
 * history the user browses and (FC-03) the diff injected alongside the active
 * file, so it is bounded in size and degrades gracefully on very large inputs
 * rather than building an O(n*m) table that could exhaust memory.
 *
 * Not a byte-perfect git diff: it is line-level with a few lines of context,
 * which is what a human skim and a model summary both want.
 */

// Above this line count (either side) or LCS product, skip the exact diff and
// emit a coarse summary — a 10MB file is millions of lines and an O(n*m) LCS
// table would OOM. Text revision files are normally far smaller.
const MAX_DIFF_LINES = 5000;
const MAX_LCS_CELLS = 4_000_000;

/**
 * Longest-common-subsequence over two line arrays, returned as a flat op list
 * of { type: 'eq'|'del'|'add', line }. Only called when within the size guard.
 */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  // DP table of LCS lengths (n+1 x m+1).
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', line: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ type: 'del', line: a[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', line: b[j] }); j++; }
  return ops;
}

/**
 * Group ops into unified-diff hunks, keeping `context` equal lines around each
 * run of changes and collapsing long equal stretches between them.
 */
function formatHunks(ops, context) {
  // Index of each change (non-eq) op.
  const changeIdx = [];
  ops.forEach((op, idx) => { if (op.type !== 'eq') changeIdx.push(idx); });
  if (changeIdx.length === 0) return '';

  // Merge changes whose gaps are within 2*context into shared hunks.
  const ranges = [];
  let start = Math.max(0, changeIdx[0] - context);
  let end = Math.min(ops.length - 1, changeIdx[0] + context);
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k];
    if (idx - context <= end + 1) {
      end = Math.min(ops.length - 1, idx + context);
    } else {
      ranges.push([start, end]);
      start = Math.max(0, idx - context);
      end = Math.min(ops.length - 1, idx + context);
    }
  }
  ranges.push([start, end]);

  const out = [];
  for (const [s, e] of ranges) {
    // Line numbers (1-based) for the @@ header, counting eq/del on the old
    // side and eq/add on the new side up to s.
    let oldNo = 1;
    let newNo = 1;
    for (let idx = 0; idx < s; idx++) {
      if (ops[idx].type !== 'add') oldNo++;
      if (ops[idx].type !== 'del') newNo++;
    }
    let oldCount = 0;
    let newCount = 0;
    const body = [];
    for (let idx = s; idx <= e; idx++) {
      const op = ops[idx];
      if (op.type === 'eq') { body.push(` ${op.line}`); oldCount++; newCount++; }
      else if (op.type === 'del') { body.push(`-${op.line}`); oldCount++; }
      else { body.push(`+${op.line}`); newCount++; }
    }
    out.push(`@@ -${oldNo},${oldCount} +${newNo},${newCount} @@`);
    out.push(...body);
  }
  return out.join('\n');
}

/**
 * Build a unified diff between two strings.
 * @param {string} oldText - prior content ('' for a newly created file)
 * @param {string} newText - new content
 * @param {Object} [opts]
 * @param {number} [opts.maxChars=20000] - hard cap on the returned string
 * @param {number} [opts.context=3] - equal lines of context around changes
 * @returns {string} unified diff, a coarse summary for oversized inputs, or ''
 *   when the two are identical
 */
function unifiedDiff(oldText, newText, { maxChars = 20000, context = 3 } = {}) {
  if (oldText === newText) return '';
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');

  // Guard: fall back to a summary rather than a huge/expensive table.
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES || a.length * b.length > MAX_LCS_CELLS) {
    return `(diff omitted — file too large: ${a.length} → ${b.length} lines)`;
  }

  const ops = diffLines(a, b);
  let text = formatHunks(ops, context);

  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n… (diff truncated at ${maxChars} characters)`;
  }
  return text;
}

module.exports = { unifiedDiff };
