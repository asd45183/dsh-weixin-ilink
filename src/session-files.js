/**
 * Physical session files, for the one operation the harness does not expose:
 * deleting a session line instead of only archiving it.
 *
 * The store groups sessions by project directory (`sessions/<project>/<id>/`),
 * and the id is the only component this module trusts: every candidate is
 * rebuilt from a validated id, so a conversation cannot name a path.
 *
 * Kept free of DSH imports so it is loadable and testable outside a profile.
 * @module dsh-weixin-ilink/session-files
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** A session id is one filesystem component: no separators, no dot-only names. */
const SAFE_SESSION_ID = /^[A-Za-z0-9@._-]+$/

/**
 * Session root for this host: the caller's `dshHomePath('sessions')` when the
 * host exposes it, else `$DSH_HOME/sessions`, else `~/.dsh/sessions`.
 * @param {string} [explicit] host-provided root
 * @returns {string} absolute directory
 */
export function sessionsRoot(explicit) {
  const provided = String(explicit ?? '').trim()
  if (provided !== '') return provided
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'sessions')
}

/**
 * Every directory that stores one session, one per project that ever ran it.
 * @param {string} sessionId session id
 * @param {string} [root] sessions root
 * @returns {string[]} existing directories, empty when the session is absent
 */
export function findSessionDirs(sessionId, root = sessionsRoot()) {
  const id = String(sessionId ?? '')
  if (id === '.' || id === '..' || !SAFE_SESSION_ID.test(id)) return []
  let projects
  try {
    projects = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = path.join(root, project.name, id)
    try {
      if (fs.statSync(candidate).isDirectory()) found.push(candidate)
    } catch {
      // not stored under this project
    }
  }
  return found
}

/**
 * Whether any project directory still stores this session.
 * @param {string} sessionId session id
 * @param {string} [root] sessions root
 * @returns {boolean} true when at least one directory exists
 */
export function hasSessionFiles(sessionId, root = sessionsRoot()) {
  return findSessionDirs(sessionId, root).length > 0
}

/**
 * Delete every stored directory for one session.
 *
 * Only directories whose final component is exactly the validated id are
 * removed, so a session id can never delete a project directory itself.
 * @param {string} sessionId session id
 * @param {string} [root] sessions root
 * @returns {string[]} removed directories
 */
export function removeSessionDirs(sessionId, root = sessionsRoot()) {
  const removed = []
  for (const dir of findSessionDirs(sessionId, root)) {
    if (path.basename(dir) !== sessionId) continue
    fs.rmSync(dir, { recursive: true, force: true })
    removed.push(dir)
  }
  return removed
}
