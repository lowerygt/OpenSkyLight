import http from 'node:http'
import crypto from 'node:crypto'
import { AddressInfo } from 'node:net'
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library'
import { safeStorage, shell } from 'electron'
import { and, eq, isNull } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { calendars, events, googleAccounts } from '../db/schema'
import type { SettingsService } from '../services/settingsService'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import { AppError, invalid, notFound } from '../services/errors'

const SCOPES = ['https://www.googleapis.com/auth/calendar', 'openid', 'email']
const KEY_CLIENT_ID = 'google.clientId'
const KEY_CLIENT_SECRET = 'google.clientSecretEnc'
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000
/** Set when a stored secret could not be decrypted (keyring changed, profile moved). */
const KEY_SECRET_NOTICE = 'google.secretNotice'
const SECRET_LOST_MSG = 'The saved Google client secret could not be read (keyring changed or profile moved). Enter it again.'
const TOKEN_LOST_MSG = 'Saved Google sign-in could not be read (keyring changed or profile moved). Reconnect this account.'

function encryptSecret(plain: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain)
  return Buffer.from(`plain:${plain}`, 'utf8')
}

function decryptSecret(buf: Buffer): string {
  const asString = buf.toString('utf8')
  if (asString.startsWith('plain:')) return asString.slice(6)
  return safeStorage.decryptString(buf)
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createGoogleAuth(db: AppDb, settings: SettingsService) {
  let connectInFlight = false

  function getCredentials(): { clientId: string; clientSecret: string } | null {
    const clientId = settings.getRaw(KEY_CLIENT_ID)
    const secretB64 = settings.getRaw(KEY_CLIENT_SECRET)
    if (!clientId || !secretB64) return null
    try {
      return { clientId, clientSecret: decryptSecret(Buffer.from(secretB64, 'base64')) }
    } catch (err) {
      // unreadable: drop it and ask for re-entry instead of failing forever
      console.warn('[google] client secret could not be decrypted; clearing it:', (err as Error).message)
      settings.deleteRaw(KEY_CLIENT_SECRET)
      settings.setRaw(KEY_SECRET_NOTICE, SECRET_LOST_MSG)
      return null
    }
  }

  function getNotice(): string | null {
    return settings.getRaw(KEY_SECRET_NOTICE)
  }

  function setCredentials(clientId: string, clientSecret: string): void {
    settings.deleteRaw(KEY_SECRET_NOTICE)
    settings.setRaw(KEY_CLIENT_ID, clientId.trim())
    settings.setRaw(KEY_CLIENT_SECRET, encryptSecret(clientSecret.trim()).toString('base64'))
  }

  function isConfigured(): boolean {
    return getCredentials() !== null
  }

  function listAccounts(): { id: string; email: string; error: string | null }[] {
    return db
      .select()
      .from(googleAccounts)
      .all()
      .map((a) => ({ id: a.id, email: a.email, error: a.lastRefreshError }))
  }

  /** Loopback OAuth flow: opens the system browser, waits for the redirect. */
  async function connect(): Promise<{ email: string }> {
    const creds = getCredentials()
    if (!creds) throw new AppError('NOT_CONFIGURED', 'Enter your Google OAuth client ID and secret first')
    if (connectInFlight) throw new AppError('BUSY', 'A Google sign-in is already in progress')
    connectInFlight = true
    try {
      const code = await waitForAuthCode(creds)
      const account = await exchangeAndStore(creds, code.code, code.redirectUri, code.verifier)
      return { email: account.email }
    } finally {
      connectInFlight = false
    }
  }

  function waitForAuthCode(creds: {
    clientId: string
    clientSecret: string
  }): Promise<{ code: string; redirectUri: string; verifier: string }> {
    return new Promise((resolve, reject) => {
      const verifier = b64url(crypto.randomBytes(32))
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())

      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          `<html><body style="font-family:sans-serif;text-align:center;padding-top:4rem">
             <h2>${code ? 'Connected!' : 'Sign-in failed'}</h2>
             <p>You can close this tab and return to your OpenSkyLight display.</p>
           </body></html>`
        )
        if (code) {
          cleanup()
          resolve({ code, redirectUri, verifier })
        } else if (error) {
          cleanup()
          reject(new AppError('AUTH_DENIED', `Google sign-in failed: ${error}`))
        }
      })

      let redirectUri = ''
      const timer = setTimeout(() => {
        cleanup()
        reject(new AppError('AUTH_TIMEOUT', 'Google sign-in timed out'))
      }, CONNECT_TIMEOUT_MS)

      function cleanup(): void {
        clearTimeout(timer)
        server.close()
      }

      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port
        redirectUri = `http://127.0.0.1:${port}`
        const client = new OAuth2Client({
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          redirectUri
        })
        const authUrl = client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: SCOPES,
          code_challenge_method: CodeChallengeMethod.S256,
          code_challenge: challenge
        })
        void shell.openExternal(authUrl)
      })
      server.on('error', (err) => {
        cleanup()
        reject(err)
      })
    })
  }

  async function exchangeAndStore(
    creds: { clientId: string; clientSecret: string },
    code: string,
    redirectUri: string,
    verifier: string
  ): Promise<{ id: string; email: string }> {
    const client = new OAuth2Client({ clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri })
    const { tokens } = await client.getToken({ code, codeVerifier: verifier, redirect_uri: redirectUri })
    if (!tokens.refresh_token) throw new AppError('NO_REFRESH_TOKEN', 'Google did not return a refresh token')

    const userinfo = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    })
    const profile = (await userinfo.json()) as { email?: string }
    const email = profile.email ?? 'unknown'

    const enc = encryptSecret(tokens.refresh_token)
    const existing = db.select().from(googleAccounts).where(eq(googleAccounts.email, email)).all()
    if (existing.length > 0) {
      db.update(googleAccounts)
        .set({ refreshTokenEnc: enc, lastRefreshError: null, connectedAt: isoUtc(DateTime.utc()) })
        .where(eq(googleAccounts.id, existing[0].id))
        .run()
      return { id: existing[0].id, email }
    }
    const id = uuidv7()
    db.insert(googleAccounts)
      .values({ id, email, refreshTokenEnc: enc, scopes: SCOPES.join(' '), connectedAt: isoUtc(DateTime.utc()) })
      .run()
    return { id, email }
  }

  /** An OAuth2Client ready for API calls for a stored account. */
  function getAuthedClient(accountId: string): OAuth2Client {
    const creds = getCredentials()
    if (!creds) throw new AppError('NOT_CONFIGURED', 'Google credentials missing')
    const [account] = db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId)).all()
    if (!account) throw notFound('Google account')
    if (!account.refreshTokenEnc) throw new AppError('REAUTH_REQUIRED', account.lastRefreshError ?? TOKEN_LOST_MSG)
    let refreshToken: string
    try {
      refreshToken = decryptSecret(Buffer.from(account.refreshTokenEnc))
    } catch (err) {
      console.warn('[google] refresh token could not be decrypted; clearing it:', (err as Error).message)
      db.update(googleAccounts)
        .set({ refreshTokenEnc: null, lastRefreshError: TOKEN_LOST_MSG })
        .where(eq(googleAccounts.id, accountId))
        .run()
      throw new AppError('REAUTH_REQUIRED', TOKEN_LOST_MSG)
    }
    const client = new OAuth2Client({ clientId: creds.clientId, clientSecret: creds.clientSecret })
    client.setCredentials({ refresh_token: refreshToken })
    return client
  }

  function markAuthError(accountId: string, message: string | null): void {
    db.update(googleAccounts).set({ lastRefreshError: message }).where(eq(googleAccounts.id, accountId)).run()
  }

  function disconnect(accountId: string): void {
    const [account] = db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId)).all()
    if (!account) throw notFound('Google account')
    const now = isoUtc(DateTime.utc())
    db.transaction((tx) => {
      const cals = tx
        .select()
        .from(calendars)
        .where(and(eq(calendars.googleAccountId, accountId), isNull(calendars.deletedAt)))
        .all()
      for (const cal of cals) {
        tx.update(events).set({ deletedAt: now }).where(and(eq(events.calendarId, cal.id), isNull(events.deletedAt))).run()
        tx.update(calendars).set({ deletedAt: now }).where(eq(calendars.id, cal.id)).run()
      }
      tx.delete(googleAccounts).where(eq(googleAccounts.id, accountId)).run()
    })
  }

  return { isConfigured, getNotice, setCredentials, connect, listAccounts, getAuthedClient, markAuthError, disconnect }
}

export type GoogleAuth = ReturnType<typeof createGoogleAuth>

export function assertHttpsUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw invalid('Not a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw invalid('Feed URLs must be http(s)')
  }
}
