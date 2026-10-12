// Where this machine's DSH lives, derived rather than written down.
//
// The probes used to hard-code `C:/Users/<username>/.dsh` and `127.0.0.1:19387`.
// That works on exactly one computer: anyone who clones this repository gets a
// probe suite that cannot authenticate, and the failure looks like "the host is
// down" rather than "this path is someone else's". The harnesses are part of
// what this repository ships, so they have to work where the reader is.
//
// Every value has an environment variable that DSH itself sets, and a fallback
// derived from the platform rather than assumed. The one thing that cannot be
// derived is the web port, so it comes from `DSH_WEB_URL` and is only guessed
// when that is absent.

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `C:\Users\x\.dsh`, or `~/.dsh` where DSH has not set the variable. */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** The profile directory, e.g. `…/.dsh/profiles/desktop`. */
export const DSH_PROFILE_DIR =
  process.env.DSH_PROFILE_DIR ?? join(DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'desktop')

/** `…/.dsh/storages/team_rooms.json` — the room store the host writes. */
export const ROOM_STORE = join(DSH_HOME, 'storages', 'team_rooms.json')

/** `…/.dsh/sessions` — one directory per session, each a multi-frame zstd log. */
export const SESSIONS_DIR = join(DSH_HOME, 'sessions')

/** `…/.dsh/.credentials.yaml` — where the browser session secret lives. */
export const CREDENTIALS = join(DSH_HOME, '.credentials.yaml')

/**
 * The authority a signed cookie is bound to: `127.0.0.1:19387`.
 *
 * The signature covers the authority, so a wrong one authenticates as nobody —
 * which the host reports as a bare 401 rather than as "your port is wrong".
 */
export const AUTHORITY = authorityOf(process.env.DSH_WEB_URL)

export const BASE = `http://${AUTHORITY}/`

function authorityOf(url) {
  if (url !== undefined && url !== '') {
    try {
      return new URL(url).host
    } catch {
      throw new Error(`DSH_WEB_URL is not a URL: ${url}`)
    }
  }
  // `dsh web` defaults to 19387. This is the only value here that is guessed,
  // and it is the only one that can be wrong on a machine DSH has not set up.
  return '127.0.0.1:19387'
}

/**
 * Sign a cookie for {@link AUTHORITY} with the browser-session secret.
 *
 * Shared by every probe that talks to the running host: the signing is easy to
 * get subtly wrong and impossible to debug from the 401 it produces.
 */
export function authCookie() {
  const secret = secretOf(CREDENTIALS)
  const body = base64url(
    Buffer.from(
      JSON.stringify({
        version: 1,
        authority: AUTHORITY,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      }),
      'utf8',
    ),
  )
  const signature = base64url(createHmac('sha256', secret).update(body).digest())
  const name = 'dsh-auth-' + base64url(createHash('sha256').update(AUTHORITY).digest())
  return `${name}=v1.${body}.${signature}`
}

function secretOf(credentials) {
  let text
  try {
    text = readFileSync(credentials, 'utf8')
  } catch (error) {
    throw new Error(
      `cannot read ${credentials} (${String(error?.code ?? error)}) — set DSH_HOME if this DSH lives elsewhere`,
    )
  }
  const at = text.indexOf('client-connection/browser-session:')
  if (at === -1) throw new Error(`no browser-session record in ${credentials}`)
  const match = /^\s+secret:\s*(\S+)\s*$/mu.exec(text.slice(at))
  if (match === null) throw new Error(`no secret under the browser-session record in ${credentials}`)
  return Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
