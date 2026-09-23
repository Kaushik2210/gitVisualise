// The website's gallery: a list of real repositories anyone can add to by pull request. Pure and
// isomorphic (no Node APIs) so it can be unit tested and run in the browser without a build step.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** owner/repo -> the slug used for its screenshot files (assets/gallery/<slug>-light.jpg | -dark.jpg). */
export function gallerySlug(repo) {
  return String(repo).replace(/[/.]/g, '_');
}

export function galleryImage(repo, theme) {
  return `assets/gallery/${gallerySlug(repo)}-${theme}.jpg`;
}

/** Returns a list of problems with `entries` (empty when every entry is well-formed and unique). */
export function validateGallery(entries) {
  const errors = [];
  if (!Array.isArray(entries)) return ['gallery.json must be an array'];
  const seen = new Set();
  entries.forEach((e, i) => {
    const at = `entry ${i}`;
    if (!e || typeof e !== 'object') { errors.push(`${at}: not an object`); return; }
    if (typeof e.repo !== 'string' || !REPO_RE.test(e.repo)) {
      errors.push(`${at}: "${e.repo}" is not a valid owner/repo`);
    } else {
      const key = e.repo.toLowerCase();
      if (seen.has(key)) errors.push(`${at}: duplicate repo "${e.repo}"`);
      seen.add(key);
    }
    if (typeof e.lang !== 'string' || !e.lang.trim()) errors.push(`${at}: missing "lang"`);
    if (typeof e.desc !== 'string' || !e.desc.trim()) errors.push(`${at}: missing "desc"`);
    else if (e.desc.length > 160) errors.push(`${at}: "desc" is ${e.desc.length} characters, keep it under 160 so cards stay a consistent height`);
  });
  return errors;
}
