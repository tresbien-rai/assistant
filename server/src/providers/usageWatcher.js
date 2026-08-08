/**
 * Passthrough usage watcher (U-02, docs/USAGE_MEASUREMENT_DESIGN.md).
 *
 * The toolless path (`provider.stream()`) is a dumb byte pipe: it forwards the
 * provider's SSE straight to the client and never touches the tool loop, so a
 * turn there records no usage at all and silently vanishes from the totals. A
 * usage feature that is quietly incomplete is worse than one that is obviously
 * missing, so this watches those bytes on the way past.
 *
 * TWO RULES hold this together:
 *
 * 1. IT NEVER TOUCHES THE BYTES. The caller forwards the chunk exactly as it
 *    always did and hands a copy here. Anything this module does wrong costs a
 *    usage row, never the user's reply.
 *
 * 2. IT CANNOT THROW. Malformed frames, truncated JSON, a provider that changes
 *    shape — all are swallowed. Same reasoning: the stream outranks the metric.
 *
 * CR is stripped rather than folded, which is the lesson from the bug that made
 * Gemini's tool loop a silent no-op (#170): Google delimits SSE frames with
 * `\r\n\r\n`, which contains no `\n\n` substring, so a separator search that
 * doesn't account for it never matches and nothing is ever parsed. Stripping
 * also cannot be defeated by a chunk boundary landing between the CR and LF.
 */

// A frame separator should arrive every few hundred bytes. If one never does,
// the stream is not what we think it is — drop the buffer rather than grow it
// without bound on a long response.
const MAX_BUFFER_CHARS = 1_000_000;

/**
 * @param {(payload: Object) => void} onPayload - called per parsed `data:` JSON
 * @returns {{push: (text: string) => void}}
 */
function createUsageWatcher(onPayload) {
  let buffer = '';

  return {
    push(text) {
      try {
        buffer += String(text).replace(/\r/g, '');
        if (buffer.length > MAX_BUFFER_CHARS) {
          // Keep the tail: a real separator is far likelier to be near the end
          // than in the megabyte we are discarding.
          buffer = buffer.slice(-4096);
        }

        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            let payload;
            try { payload = JSON.parse(data); } catch { continue; }
            try { onPayload(payload); } catch { /* a bad handler is not the stream's problem */ }
          }
        }
      } catch { /* rule 2 */ }
    },
  };
}

/**
 * Latch Anthropic usage across a passthrough stream.
 *
 * `message_start` carries the input side up front; `message_delta` carries the
 * settled output count at the end. Merging both is what makes the total right —
 * reading only `message_start` would report every turn as one output token.
 *
 * @returns {{push: (text: string) => void, usage: () => Object|null}}
 */
function anthropicUsageWatcher() {
  let usage = null;
  const merge = (u) => { usage = { ...(usage || {}), ...u }; };
  const watcher = createUsageWatcher((payload) => {
    if (payload?.type === 'message_start' && payload.message?.usage) merge(payload.message.usage);
    else if (payload?.type === 'message_delta' && payload.usage) merge(payload.usage);
  });
  return { push: watcher.push, usage: () => usage };
}

/**
 * Latch Gemini usage across a passthrough stream. Every chunk repeats the
 * running `usageMetadata`, so the last one seen is the total.
 *
 * @returns {{push: (text: string) => void, usage: () => Object|null}}
 */
function geminiUsageWatcher() {
  let usage = null;
  const watcher = createUsageWatcher((payload) => {
    if (payload?.usageMetadata) usage = payload.usageMetadata;
  });
  return { push: watcher.push, usage: () => usage };
}

module.exports = { createUsageWatcher, anthropicUsageWatcher, geminiUsageWatcher };
