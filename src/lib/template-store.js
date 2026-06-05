'use strict';
/**
 * template-store.js — persistence + catalog for menu templates (v1.13.0).
 *
 * Built-in templates ship read-only in src/assets/templates/*.json. User
 * templates are editable JSON files under the Electron userData dir
 * (app.getPath('userData')/templates), so they survive app updates. This module
 * is the single source of truth for listing, loading, saving, duplicating, and
 * deleting templates; main.js's IPC handlers are thin wrappers over it.
 *
 * The userData directory is resolved lazily from Electron at first use, so this
 * module is usable in plain-node tests via setUserTemplatesDir().
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { loadTemplate, validateTemplate, BUILTIN_DIR } = require('./template');

let _userDir = null;

/** Override the user-templates directory (used by tests / non-Electron callers). */
function setUserTemplatesDir(dir) { _userDir = dir; }

/** Resolve the user-templates directory (Electron userData, lazily). */
function getUserTemplatesDir() {
  if (_userDir) return _userDir;
  try {
    // Resolved lazily so this module loads outside Electron (tests).
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      _userDir = path.join(app.getPath('userData'), 'templates');
    }
  } catch { /* not running under Electron */ }
  if (!_userDir) _userDir = path.join(os.homedir(), '.disc-forge', 'templates');
  return _userDir;
}

function ensureUserDir() {
  const d = getUserTemplatesDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** kebab-case slug from a free-text name; safe as a filename. */
function slugify(name) {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'template';
}

/** List the built-in (read-only) templates. */
function listBuiltIn() {
  if (!fs.existsSync(BUILTIN_DIR)) return [];
  return fs.readdirSync(BUILTIN_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const p = path.join(BUILTIN_DIR, f);
      try {
        const t = JSON.parse(fs.readFileSync(p, 'utf8'));
        const layout = (t.button && t.button.layout === 'horizontal') ? 'horizontal' : 'vertical';
        return { id: t.id, name: t.name, category: t.category || 'Other', layout, path: p, readonly: true };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** List the user (editable) templates. */
function listUser() {
  const d = getUserTemplatesDir();
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const p = path.join(d, f);
      try {
        const t = JSON.parse(fs.readFileSync(p, 'utf8'));
        const layout = (t.button && t.button.layout === 'horizontal') ? 'horizontal' : 'vertical';
        return { id: t.id || path.basename(f, '.json'), name: t.name || t.id, layout, path: p, readonly: false };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The full catalog: built-ins first, then user templates. */
function list() {
  return [...listBuiltIn(), ...listUser()];
}

function isBuiltInId(id) {
  return listBuiltIn().some(t => t.id === id);
}
function userPath(id) {
  return path.join(getUserTemplatesDir(), `${id}.json`);
}

/**
 * Load a template by id. Built-in ids are reserved and always resolve to the
 * bundled read-only file; otherwise the user dir is consulted.
 */
function loadById(id) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('loadById: id required');
  if (isBuiltInId(id)) return loadTemplate(id);
  const p = userPath(id);
  if (!fs.existsSync(p)) throw new Error(`template not found: ${id}`);
  return loadTemplate(p);
}

/**
 * Save a user template. Validates first. The id is taken from template.id, or
 * derived from template.name when absent. Built-in ids are reserved — saving
 * over one throws. Returns the saved id.
 */
function saveUser(template) {
  if (!template || typeof template !== 'object') throw new Error('saveUser: template object required');
  const obj = { ...template };
  if (!obj.id || !String(obj.id).trim()) obj.id = slugify(obj.name);
  obj.id = slugify(obj.id);
  if (isBuiltInId(obj.id)) {
    throw new Error(`saveUser: '${obj.id}' is a built-in (read-only) template id; choose a different name`);
  }
  validateTemplate(obj);
  ensureUserDir();
  fs.writeFileSync(userPath(obj.id), JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return obj.id;
}

/**
 * "Save As": save the given template (e.g. an edited draft) under a NEW name,
 * enforcing uniqueness against the whole catalog (built-in + user) by both
 * slugified id and case-insensitive display name. Unlike saveUser (which
 * overwrites by id) this refuses to clobber an existing template. Returns the
 * new id.
 */
function saveAsUser(template, newName) {
  if (!template || typeof template !== 'object') throw new Error('saveAsUser: template object required');
  const name = String(newName || '').trim();
  if (!name) throw new Error('saveAsUser: a name is required');
  const id = slugify(name);
  if (isBuiltInId(id)) throw new Error(`'${name}' collides with a built-in template`);
  const existing = [...listBuiltIn(), ...listUser()];
  if (existing.some(t => t.id === id)) throw new Error(`a template with id '${id}' already exists`);
  if (existing.some(t => (t.name || '').toLowerCase() === name.toLowerCase())) {
    throw new Error(`a template named '${name}' already exists`);
  }
  const obj = JSON.parse(JSON.stringify(template));
  obj.id = id;
  obj.name = name;
  validateTemplate(obj);
  ensureUserDir();
  fs.writeFileSync(userPath(id), JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return id;
}

/**
 * Duplicate a template (built-in or user) into the user dir under newName.
 * The new id is slugified from newName and made unique against the existing
 * catalog. Returns the new id.
 */
function duplicate(id, newName) {
  const src = loadById(id);
  const copy = JSON.parse(JSON.stringify(src));
  copy.name = (newName && String(newName).trim()) || `${src.name} copy`;

  // A built-in image template (e.g. Cinema/Theatrical) carries no portable image
  // file of its own — duplicating it must not leave a dangling image reference, so
  // start the copy as a solid background (the fallback color is kept). User image
  // templates DO carry a `file`, so this guard leaves those untouched.
  if (copy.background && copy.background.type === 'image' && !copy.background.file) {
    copy.background.type = 'solid';
    delete copy.background.imagePath;
  }

  // Choose a unique, non-built-in id.
  const taken = new Set([...listBuiltIn(), ...listUser()].map(t => t.id));
  let base = slugify(copy.name);
  if (isBuiltInId(base)) base = `${base}-copy`;
  let candidate = base, n = 2;
  while (taken.has(candidate)) candidate = `${base}-${n++}`;
  copy.id = candidate;

  validateTemplate(copy);
  ensureUserDir();
  fs.writeFileSync(userPath(copy.id), JSON.stringify(copy, null, 2) + '\n', 'utf8');
  return copy.id;
}

/** Delete a user template. Throws on a built-in (read-only) id. */
function deleteUser(id) {
  if (isBuiltInId(id)) throw new Error(`deleteUser: '${id}' is a built-in (read-only) template and cannot be deleted`);
  const p = userPath(id);
  if (!fs.existsSync(p)) throw new Error(`deleteUser: template not found: ${id}`);
  fs.unlinkSync(p);
  return true;
}

module.exports = {
  setUserTemplatesDir,
  getUserTemplatesDir,
  listBuiltIn,
  listUser,
  list,
  isBuiltInId,
  loadById,
  saveUser,
  saveAsUser,
  duplicate,
  deleteUser,
  slugify,
};
