/**
 * Orphaned avatar/expression image sweep
 *
 * Avatar and expression images live on the server filesystem
 * (`server/data/avatars/`) and are referenced from the database
 * (`personas.avatar_filename` and each expression's `imageKey`). Eager cleanup
 * in the persona routes removes files when a persona is deleted or an
 * expression is dropped, but a crash between the DB write and the unlink — or
 * any path we haven't covered — can still strand a file. This sweep reconciles
 * the directory against the database and deletes anything unreferenced.
 *
 * It is the catch-all safety net, not the primary mechanism. See
 * docs/ORPHANED_IMAGES_DESIGN.md.
 *
 * Guards against reaping live files:
 *   - `tmp_*` — multer's in-flight upload temp files.
 *   - age grace — a file whose mtime is within `graceMs` of now, so an image
 *     just uploaded whose DB write hasn't landed yet is never reaped.
 */

const fs = require('fs');
const path = require('path');
const dal = require('../db/dal');
const { logger } = require('../utils/logger');
const { AVATARS_DIR, personaImageRefs } = require('../routes/avatars');

// Don't reap files younger than this — covers the window between an upload
// landing on disk and its DB reference being written.
const DEFAULT_GRACE_MS = 5 * 60 * 1000;
// Default cadence for the periodic timer.
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Delay before the first sweep after boot, so startup isn't blocked by it.
const DEFAULT_INITIAL_DELAY_MS = 30 * 1000;

/**
 * Build the set of every image filename referenced by any persona in the DB.
 * @returns {Set<string>}
 */
function collectReferencedFiles() {
  const referenced = new Set();
  for (const persona of dal.getAllPersonaImageRefs()) {
    for (const filename of personaImageRefs(persona)) {
      referenced.add(filename);
    }
  }
  return referenced;
}

/**
 * Delete every image file in AVATARS_DIR that no persona references, subject to
 * the tmp_ and age guards. Synchronous and best-effort — individual failures
 * are logged, never thrown.
 * @param {{graceMs?: number}} [opts]
 * @returns {{scanned: number, referenced: number, deleted: number}}
 */
function sweepOrphanedAvatars({ graceMs = DEFAULT_GRACE_MS } = {}) {
  let files;
  try {
    files = fs.readdirSync(AVATARS_DIR);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn({ err, dir: AVATARS_DIR }, 'avatar sweep: cannot read directory');
    }
    return { scanned: 0, referenced: 0, deleted: 0 };
  }

  const referenced = collectReferencedFiles();
  const cutoff = Date.now() - graceMs;
  let deleted = 0;

  for (const filename of files) {
    if (filename.startsWith('.')) continue;       // dotfiles, e.g. .gitkeep
    if (filename.startsWith('tmp_')) continue;    // in-flight upload
    if (referenced.has(filename)) continue;       // live reference

    const filePath = path.join(AVATARS_DIR, filename);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue; // vanished between readdir and stat — nothing to do
    }
    if (!stat.isFile()) continue;
    if (stat.mtimeMs > cutoff) continue;          // too fresh — maybe mid-upload

    try {
      fs.unlinkSync(filePath);
      deleted += 1;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn({ err, filename }, 'avatar sweep: failed to delete orphan');
      }
    }
  }

  logger.info(
    { scanned: files.length, referenced: referenced.size, deleted },
    'avatar sweep complete'
  );
  return { scanned: files.length, referenced: referenced.size, deleted };
}

/**
 * Start the periodic sweep: one run shortly after boot, then on a repeating
 * interval. Both timers are `.unref()`'d so they never keep the process alive.
 * Disabled under NODE_ENV=test and when AVATAR_SWEEP_ENABLED=false. Cadence
 * overridable via AVATAR_SWEEP_INTERVAL_MS.
 * @param {{intervalMs?: number, initialDelayMs?: number}} [opts]
 * @returns {NodeJS.Timeout|null} the interval handle, or null if disabled
 */
function startAvatarSweep({ intervalMs, initialDelayMs = DEFAULT_INITIAL_DELAY_MS } = {}) {
  if (process.env.NODE_ENV === 'test' || process.env.AVATAR_SWEEP_ENABLED === 'false') {
    return null;
  }

  const interval =
    intervalMs || Number(process.env.AVATAR_SWEEP_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  const run = () => {
    try {
      sweepOrphanedAvatars();
    } catch (err) {
      logger.error({ err }, 'avatar sweep crashed');
    }
  };

  const first = setTimeout(run, initialDelayMs);
  if (first.unref) first.unref();

  const timer = setInterval(run, interval);
  if (timer.unref) timer.unref();

  logger.info({ intervalMs: interval }, 'avatar sweep scheduled');
  return timer;
}

module.exports = {
  sweepOrphanedAvatars,
  startAvatarSweep,
  collectReferencedFiles,
  DEFAULT_GRACE_MS,
};
