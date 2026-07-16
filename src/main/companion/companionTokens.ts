import {createHash, randomBytes, timingSafeEqual} from 'node:crypto'
import type {SettingsService} from '../services/settingsService'

const STORE_KEY = 'companion.tokens.v1'
/** Oldest pairings are pruned past this — a household has nowhere near 20 phones. */
const MAX_TOKENS = 20
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90 // 90 days
const TOUCH_INTERVAL_MS = 1000 * 60 * 30 // update metadata at most every 30m

interface StoredToken {
    hash: string
    createdAt: number
    lastSeenAt: number
    expiresAt: number
    revokedAt: number | null
}

/**
 * Pairing tokens for the companion web app. Only sha256 hashes are stored
 * (the PIN pattern); the plaintext token exists once, inside the QR URL the
 * parent scans. A 256-bit random token needs no stretching — sha256 +
 * timingSafeEqual is the right tool here, scrypt is for low-entropy PINs.
 */
export function createCompanionTokens(settings: Pick<SettingsService, 'getRaw' | 'setRaw' | 'deleteRaw'>) {
    function readTokens(now = Date.now()): StoredToken[] {
        const raw = settings.getRaw(STORE_KEY)
        if (!raw) return []
        try {
            const parsed = JSON.parse(raw)
            // Backward-compat migration from v1 string[] hash store
            if (Array.isArray(parsed) && parsed.every((h) => typeof h === 'string')) {
                return parsed.map((hash) => ({
                    hash,
                    createdAt: now,
                    lastSeenAt: now,
                    expiresAt: now + TOKEN_TTL_MS,
                    revokedAt: null
                }))
            }
            if (!Array.isArray(parsed)) return []
            return parsed.filter(
                (t): t is StoredToken =>
                    !!t &&
                    typeof t === 'object' &&
                    typeof t.hash === 'string' &&
                    typeof t.createdAt === 'number' &&
                    typeof t.lastSeenAt === 'number' &&
                    typeof t.expiresAt === 'number' &&
                    (typeof t.revokedAt === 'number' || t.revokedAt === null)
            )
        } catch {
            return []
        }
    }

    function writeTokens(tokens: StoredToken[]): void {
        if (tokens.length === 0) {
            settings.deleteRaw(STORE_KEY)
            return
        }
        settings.setRaw(STORE_KEY, JSON.stringify(tokens))
    }

    function prune(tokens: StoredToken[], now = Date.now()): StoredToken[] {
        return tokens
            .filter((t) => t.revokedAt === null && t.expiresAt > now)
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(-MAX_TOKENS)
    }

    const hashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

    /** Mint a new token; returns the plaintext exactly once. Older pairings stay valid. */
    function issue(): string {
        const now = Date.now()
        const token = randomBytes(32).toString('base64url')
        const next = prune(
            [
                ...readTokens(now),
                {
                    hash: hashOf(token),
                    createdAt: now,
                    lastSeenAt: now,
                    expiresAt: now + TOKEN_TTL_MS,
                    revokedAt: null
                }
            ],
            now
        )
        writeTokens(next)
        return token
    }

    function verify(token: string): boolean {
        if (typeof token !== 'string' || token.length === 0 || token.length > 128) return false
        const now = Date.now()
        const candidate = Buffer.from(hashOf(token), 'hex')
        const tokens = prune(readTokens(now), now)
        let valid = false
        let changed = false
        for (const stored of tokens) {
            const buf = Buffer.from(stored.hash, 'hex')
            if (buf.length === candidate.length && timingSafeEqual(buf, candidate)) {
                valid = true
                if (now - stored.lastSeenAt >= TOUCH_INTERVAL_MS) {
                    stored.lastSeenAt = now
                    stored.expiresAt = now + TOKEN_TTL_MS
                    changed = true
                }
            }
        }
        if (changed) {
            writeTokens(tokens)
        }
        return valid
    }

    function revokeAll(): void {
        settings.deleteRaw(STORE_KEY)
    }

    function count(): number {
        const now = Date.now()
        const tokens = prune(readTokens(now), now)
        writeTokens(tokens)
        return tokens.length
    }

    return {issue, verify, revokeAll, count}
}

export type CompanionTokens = ReturnType<typeof createCompanionTokens>
