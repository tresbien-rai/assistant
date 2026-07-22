/**
 * Persona bundle (`.tessera`) — format definition + import validation
 *
 * A bundle is a single self-contained JSON document describing one persona,
 * with its avatar and expression art inlined as base64 data. Plain JSON rather
 * than a zip so a shared persona can be read in any text editor BEFORE it is
 * imported — you can see the system prompt you're about to run. It gzips well
 * if size ever becomes a problem, which is a non-breaking change since the
 * schema stays identical.
 *
 * The envelope carries `kind` so workspaces/projects can reuse the same
 * extension and importer later instead of growing bespoke formats.
 *
 *   {
 *     "format": "tessera.bundle",
 *     "version": 1,
 *     "kind": "persona",
 *     "exportedAt": 1753142400000,
 *     "persona": {
 *       "name": "Vega",
 *       "tagline": "Reads the footnotes so you never have to.",
 *       "roleLabel": "Researcher",
 *       "systemPrompt": "...",
 *       "avatar": { "mimeType": "image/webp", "data": "<base64>" } | null,
 *       "expressions": {
 *         "happy": { "emoji": "😄", "image": { "mimeType": "...", "data": "..." } | null }
 *       }
 *     }
 *   }
 *
 * EVERYTHING here is untrusted — a bundle arrives from another person. Nothing
 * in it is used without passing through validateBundle().
 *
 * Deliberately NOT part of the format:
 * - id / userId / timestamps — regenerated on import.
 * - modelConfig — a fixed model pin would reference a model the importer may
 *   not have configured, breaking the persona on first send. Imports land in
 *   shared mode.
 * - toolsEnabled — file-tool access is the importer's decision about their own
 *   Drive, never the exporter's. Imports are always tools-off.
 */

const { sanitizeExpressionNames } = require('../prompts/tessera');
const AppError = require('./AppError');

const BUNDLE_FORMAT = 'tessera.bundle';
const BUNDLE_VERSION = 1;
const BUNDLE_KIND_PERSONA = 'persona';

// Caps. These bound how much work a single import can cause; the request body
// limit on the route is the outer bound.
const MAX_NAME = 80;
const MAX_TAGLINE = 80;
const MAX_ROLE_LABEL = 24;
const MAX_SYSTEM_PROMPT = 100_000;
const MAX_EXPRESSIONS = 24;
const MAX_EMOJI = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // matches the avatar upload limit

/**
 * Image types we accept, keyed by MIME, with the magic bytes that actually
 * prove it. The declared mimeType is a hint; the bytes decide.
 */
const IMAGE_TYPES = {
  'image/png': { ext: '.png', check: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: '.jpg', check: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: '.gif', check: (b) => b.length > 6 && b.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/) !== null },
  'image/webp': { ext: '.webp', check: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

/**
 * Trim a value to a string of at most `max` characters.
 * @param {unknown} value
 * @param {number} max
 * @returns {string} '' when the value isn't a usable string
 */
function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Decode and verify one inlined image.
 *
 * The declared mimeType is never trusted on its own — the decoded bytes must
 * match that type's magic number. This is what stops a bundle from smuggling
 * arbitrary content onto disk under an image extension.
 *
 * @param {unknown} image - { mimeType, data } from the bundle
 * @param {string} where - Label for the error message
 * @returns {{ buffer: Buffer, mimeType: string, ext: string }|null} null when absent
 */
function decodeImage(image, where) {
  if (image === null || image === undefined) return null;
  if (typeof image !== 'object') {
    throw AppError.validation(`${where}: image must be an object`);
  }

  const mimeType = typeof image.mimeType === 'string' ? image.mimeType.toLowerCase() : '';
  const spec = IMAGE_TYPES[mimeType];
  if (!spec) {
    throw AppError.validation(`${where}: unsupported image type "${image.mimeType}"`);
  }
  if (typeof image.data !== 'string' || image.data.length === 0) {
    throw AppError.validation(`${where}: image data must be a base64 string`);
  }
  // Reject before allocating: base64 is 4 chars per 3 bytes.
  if (image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
    throw AppError.validation(`${where}: image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
  }

  let buffer;
  try {
    buffer = Buffer.from(image.data, 'base64');
  } catch {
    throw AppError.validation(`${where}: image data is not valid base64`);
  }
  if (buffer.length === 0) {
    throw AppError.validation(`${where}: image data is empty`);
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw AppError.validation(`${where}: image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
  }
  if (!spec.check(buffer)) {
    throw AppError.validation(`${where}: image contents don't match declared type ${mimeType}`);
  }

  return { buffer, mimeType, ext: spec.ext };
}

/**
 * Validate an untrusted persona bundle and return the pieces needed to create
 * the persona. Throws AppError.validation on anything malformed.
 *
 * @param {unknown} bundle - Parsed bundle JSON
 * @returns {{
 *   persona: { name: string, tagline: string, roleLabel: string, systemPrompt: string, expressions: Object },
 *   avatar: { buffer: Buffer, mimeType: string, ext: string }|null,
 *   expressionImages: Array<{ name: string, buffer: Buffer, mimeType: string, ext: string }>
 * }}
 */
function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw AppError.validation('Not a valid Tessera bundle');
  }
  if (bundle.format !== BUNDLE_FORMAT) {
    throw AppError.validation('Not a Tessera bundle file');
  }
  if (bundle.kind !== BUNDLE_KIND_PERSONA) {
    throw AppError.validation(`This bundle contains "${bundle.kind}", not a persona`);
  }
  // Forward-compat: refuse newer formats rather than guessing at them.
  if (typeof bundle.version !== 'number' || bundle.version > BUNDLE_VERSION) {
    throw AppError.validation('This bundle was made by a newer version of Tessera');
  }

  const src = bundle.persona;
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    throw AppError.validation('Bundle is missing its persona');
  }

  const name = str(src.name, MAX_NAME) || 'Imported Persona';
  const avatar = decodeImage(src.avatar, 'avatar');

  // Expression names are interpolated into the system prompt, so they go
  // through the same sanitizer the live chat path uses.
  const rawExpressions = (src.expressions && typeof src.expressions === 'object' && !Array.isArray(src.expressions))
    ? src.expressions
    : {};
  const acceptedNames = sanitizeExpressionNames(Object.keys(rawExpressions)).slice(0, MAX_EXPRESSIONS);

  const expressions = {};
  const expressionImages = [];
  for (const exprName of acceptedNames) {
    const entry = rawExpressions[exprName];
    if (!entry || typeof entry !== 'object') continue;
    const key = exprName.toLowerCase();
    const image = decodeImage(entry.image, `expression "${key}"`);
    expressions[key] = {
      emoji: str(entry.emoji, MAX_EMOJI) || '🙂',
      // Set below only if the image is actually written to disk.
      imageKey: '',
    };
    if (image) expressionImages.push({ name: key, ...image });
  }

  return {
    persona: {
      name,
      tagline: str(src.tagline, MAX_TAGLINE),
      roleLabel: str(src.roleLabel, MAX_ROLE_LABEL),
      systemPrompt: str(src.systemPrompt, MAX_SYSTEM_PROMPT),
      expressions,
    },
    avatar,
    expressionImages,
  };
}

module.exports = {
  validateBundle,
  decodeImage,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  BUNDLE_KIND_PERSONA,
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
};
