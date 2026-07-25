/**
 * Rich diff rendering (R-03, moved verbatim from main.js).
 *
 * Turns a unified diff into DOM: line-level classification plus word-level
 * highlighting inside changed pairs. A leaf — it builds elements and reads
 * nothing from app state. `formatRelativeTime`, which used to sit at the top of
 * this section, went to util/format.js with the other formatters.
 */

// ===== Rich diff viewer helpers (FC-06b) =====

/** Count added / deleted lines in a unified diff (hunk headers excluded). */
export function diffStats(diffText) {
    let adds = 0, dels = 0;
    if (diffText) {
        for (const line of diffText.split('\n')) {
            const c = line.charAt(0);
            if (c === '+') adds++;
            else if (c === '-') dels++;
        }
    }
    return { adds, dels };
}

/** Split a string into word / whitespace / punctuation tokens (for word diff). */
function tokenizeLine(s) {
    return s.match(/(\s+|\w+|[^\w\s])/g) || [];
}

/**
 * Token-level LCS diff between two strings → { oldParts, newParts }, each a list
 * of { text, changed } runs. Powers the intra-line word highlighting so the eye
 * lands on exactly what changed, not just which line changed.
 */
function computeWordDiff(oldStr, newStr) {
    const a = tokenizeLine(oldStr), b = tokenizeLine(newStr);
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const oldParts = [], newParts = [];
    const push = (arr, text, changed) => {
        const last = arr[arr.length - 1];
        if (last && last.changed === changed) last.text += text;
        else arr.push({ text, changed });
    };
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { push(oldParts, a[i], false); push(newParts, b[j], false); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { push(oldParts, a[i], true); i++; }
        else { push(newParts, b[j], true); j++; }
    }
    while (i < n) { push(oldParts, a[i], true); i++; }
    while (j < m) { push(newParts, b[j], true); j++; }
    return { oldParts, newParts };
}

/** One diff line (prefix stripped); `kind` is hunk|ctx|del|add. */
function rdiffLine(kind, rawLine) {
    const div = document.createElement('div');
    div.className = 'fp-rline fp-r' + kind;
    div.textContent = kind === 'hunk' ? rawLine : rawLine.slice(1);
    return div;
}

/** A del/add line rendered from word-diff parts, changed tokens highlighted. */
function rdiffLineTokens(kind, parts) {
    const div = document.createElement('div');
    div.className = 'fp-rline fp-r' + kind;
    parts.forEach(p => {
        if (p.changed) {
            const mark = document.createElement('span');
            mark.className = 'fp-tok';
            mark.textContent = p.text;
            div.appendChild(mark);
        } else {
            div.appendChild(document.createTextNode(p.text));
        }
    });
    return div;
}

/**
 * Render a unified diff into an editorial-minimal element with word-level
 * highlighting: consecutive − / + runs are paired by index and token-diffed so
 * the changed words stand out; unpaired lines render plainly.
 */
export function buildRichDiff(diffText) {
    const container = document.createElement('div');
    container.className = 'fp-rdiff';
    if (!diffText) {
        container.innerHTML = '<p class="file-panel-empty">No content changes recorded for this version.</p>';
        return container;
    }
    const lines = diffText.split('\n');
    let i = 0;
    while (i < lines.length) {
        const c = lines[i].charAt(0);
        if (c === '@') {
            container.appendChild(rdiffLine('hunk', lines[i]));
            i++;
        } else if (c === '-') {
            const dels = []; while (i < lines.length && lines[i].charAt(0) === '-') { dels.push(lines[i]); i++; }
            const adds = []; while (i < lines.length && lines[i].charAt(0) === '+') { adds.push(lines[i]); i++; }
            // Pair by index for word-level highlights; show all − then all +.
            const oldEls = [], newEls = [];
            const pairs = Math.max(dels.length, adds.length);
            for (let k = 0; k < pairs; k++) {
                const d = dels[k], a = adds[k];
                if (d != null && a != null) {
                    const { oldParts, newParts } = computeWordDiff(d.slice(1), a.slice(1));
                    oldEls.push(rdiffLineTokens('del', oldParts));
                    newEls.push(rdiffLineTokens('add', newParts));
                } else if (d != null) { oldEls.push(rdiffLine('del', d)); }
                else if (a != null) { newEls.push(rdiffLine('add', a)); }
            }
            oldEls.forEach(el => container.appendChild(el));
            newEls.forEach(el => container.appendChild(el));
        } else if (c === '+') {
            const adds = []; while (i < lines.length && lines[i].charAt(0) === '+') { adds.push(lines[i]); i++; }
            adds.forEach(l => container.appendChild(rdiffLine('add', l)));
        } else {
            // Context, or one of our note lines ("… (diff truncated …)").
            container.appendChild(rdiffLine('ctx', lines[i]));
            i++;
        }
    }
    return container;
}
