/**
 * The one-admitted-qfn-job-per-class lease, shared with the Go authority
 * (M2).
 *
 * This is not a second capacity manager. `internal/pair/classlease.go` is the
 * authority on this host, and this module implements the **same** directory,
 * filename, record shape, create-exclusively rule and reclaim rule, so a
 * relayed zcode turn and a pairctl zcode turn contend for the same slot and a
 * second saved session, a different harness name or a provider alias buys
 * nobody extra capacity.
 *
 * On-disk contract (mirrored from the Go source, byte for byte):
 *   dir    `QFN_CLASS_LEASE_DIR`, default `/tmp/qfn-class-lease`, mode 0700
 *   file   `class-<hex(sha256(class)[0..16])>.lock`, mode 0600, O_CREAT|O_EXCL
 *   record `{"class","pid","nonce","acquired","owner"}` — identity only, never
 *          a prompt, a session text or a credential (M8)
 *   steal  only when the recorded pid is provably dead; an unreadable record is
 *          stealable, an unparsable one only after 6 hours
 *
 * @module zcode-relay/classlease
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_CLASS_LEASE_DIR = '/tmp/qfn-class-lease'
export const CLASS_LEASE_DIR_ENV = 'QFN_CLASS_LEASE_DIR'
const STALE_AFTER_MS = 6 * 60 * 60 * 1000

/** Thrown when the class is already admitted elsewhere. */
export class TurnBusyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TurnBusyError'
    this.code = 'TURN_BUSY'
  }
}

export function classLeaseDir(env = process.env) {
  const raw = String(env[CLASS_LEASE_DIR_ENV] ?? '').trim()
  return raw === '' ? DEFAULT_CLASS_LEASE_DIR : raw
}

export function classLeasePath(classKey, env = process.env) {
  const digest = createHash('sha256').update(String(classKey)).digest('hex').slice(0, 32)
  return join(classLeaseDir(env), `class-${digest}.lock`)
}

/** `kill(pid, 0)` liveness, mirroring the Go `processAlive`. */
export function processAlive(pid, kill = process.kill.bind(process)) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try {
    kill(value, 0)
    return true
  } catch (error) {
    // EPERM means the process exists and simply is not ours to signal.
    return error?.code === 'EPERM'
  }
}

function stealable(path, fs) {
  let body
  try {
    body = fs.readFileSync(path, 'utf8')
  } catch {
    return true // vanished or unreadable: let the next create settle it
  }
  let record
  try {
    record = JSON.parse(body)
  } catch {
    record = undefined
  }
  const pid = Number(record?.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    let stat
    try {
      stat = fs.statSync(path)
    } catch {
      return false
    }
    return Date.now() - stat.mtimeMs > STALE_AFTER_MS
  }
  return !processAlive(pid)
}

/**
 * Take the class lease, or throw TurnBusyError when a live process already
 * holds it. `owner` is a diagnostic label only.
 */
export function acquireClassLease(classKey, owner, options = {}) {
  const env = options.env ?? process.env
  const fs = options.fs ?? { readFileSync, writeFileSync, statSync, mkdirSync, openSync, closeSync, rmSync }
  const nonce = options.nonce ?? randomUUID()
  const dir = classLeaseDir(env)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = classLeasePath(classKey, env)
  const record = {
    class: classKey,
    pid: options.pid ?? process.pid,
    nonce,
    acquired: new Date().toISOString(),
    owner: String(owner ?? ''),
  }
  const body = JSON.stringify(record)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(path, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, body)
      } finally {
        fs.closeSync(fd)
      }
      return new ClassLease({ path, classKey, nonce, fs, env })
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw new Error(`class lease create: ${error?.message ?? error}`)
      }
      if (!stealable(path, fs)) {
        throw new TurnBusyError(`class ${classKey} is already admitted`)
      }
      try {
        fs.rmSync?.(path, { force: true })
      } catch {
        /* the retry settles it */
      }
    }
  }
  throw new TurnBusyError(`class ${classKey} stayed busy`)
}

/** A held lease. `release` is idempotent and never frees somebody else's slot. */
export class ClassLease {
  #held = true

  constructor({ path, classKey, nonce, fs, env }) {
    this.path = path
    this.class = classKey
    this.nonce = nonce
    this.ownerPid = process.pid
    this.fs = fs
    this.env = env
  }

  held() {
    return this.#held
  }

  /** The record another holder would see — for contention reporting, never for capacity. */
  current() {
    try {
      return JSON.parse(this.fs.readFileSync(this.path, 'utf8'))
    } catch {
      return undefined
    }
  }

  release() {
    if (!this.#held) return { released: false, reason: 'not-held' }
    this.#held = false
    let record
    try {
      record = JSON.parse(this.fs.readFileSync(this.path, 'utf8'))
    } catch {
      return { released: false, reason: 'already-gone' } // nothing of ours to free
    }
    if (record?.nonce !== this.nonce) {
      return { released: false, reason: 'owned-by-another' }
    }
    try {
      this.fs.rmSync?.(this.path, { force: true })
    } catch (error) {
      return { released: false, reason: `release-failed: ${error?.message ?? error}` }
    }
    return { released: true }
  }
}
