// Offline store (roadmap 4.6): encrypted IndexedDB cache of what the user
// has seen (accounts, folders, first list pages, opened messages, threads,
// sanitized HTML, identities) plus the offline queue - never the service
// worker's Cache Storage (sw.js keeps /api/* network-only).
//
// Security (docs/architecture/security.md, "Offline-Cache im Client"):
// - Every value is encrypted with AES-256-GCM under a NON-EXTRACTABLE
//   WebCrypto key that is generated on the device and kept in the same
//   database. Scripts can use it but never read its bytes; deleting it
//   (logout, session expired/revoked) makes all leftovers unreadable even
//   if the browser deletes the data lazily. The entry key is the AAD, so
//   swapped records fail to decrypt.
// - Writes only happen while the store is enabled (an authenticated
//   session); clearOfflineData() disables it first, so responses that
//   arrive after a logout cannot recreate the cache.
// - Without IndexedDB or WebCrypto (private mode, plain-http LAN address)
//   the app simply works online-only.
//
// Size: entries larger than MAX_ENTRY_BYTES are not cached; the rest is
// bounded by LRU eviction (selectEvictions from @fma/shared). Account and
// folder lists, identities, the session marker and the queue are pinned.
import { DEFAULT_CACHE_LIMITS, selectEvictions, type CacheEntryInfo } from '@fma/shared'

const DB_NAME = 'fma-offline'
const DB_VERSION = 1
const META = 'meta'
const ENTRY_META = 'entryMeta'
const ENTRY_DATA = 'entryData'
const KEY_ID = 'cacheKey'
const MAX_ENTRY_BYTES = 5 * 1024 * 1024
const EVICT_DELAY_MS = 2000

interface EntryMeta extends CacheEntryInfo {
  accountId: string | null
}

interface EntryData {
  key: string
  iv: Uint8Array<ArrayBuffer>
  data: ArrayBuffer
}

export interface PutOptions {
  /** Owning mail account (removed with the account); null for global entries. */
  accountId?: string | null
  /** Never evicted (small lists the app needs to start offline). */
  pinned?: boolean
}

let enabled = false
// After clearOfflineData() nothing may touch IndexedDB again (a late read
// would recreate the database) until the next login enables the store.
let cleared = false
let dbPromise: Promise<IDBDatabase | null> | null = null
let keyPromise: Promise<CryptoKey | null> | null = null
let evictTimer: ReturnType<typeof setTimeout> | undefined

function supported(): boolean {
  return (
    typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle?.encrypt
  )
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function openDb(): Promise<IDBDatabase | null> {
  if (!supported() || cleared) return Promise.resolve(null)
  dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore(META)
      const meta = db.createObjectStore(ENTRY_META, { keyPath: 'key' })
      meta.createIndex('accountId', 'accountId')
      db.createObjectStore(ENTRY_DATA, { keyPath: 'key' })
    }
    request.onsuccess = () => {
      const db = request.result
      // Another tab deletes the database (logout there): let it.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
        keyPromise = null
      }
      resolve(db)
    }
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return dbPromise
}

/**
 * The device's cache key: generated once (only while enabled, i.e. after a
 * confirmed login), non-extractable.
 */
async function cacheKey(): Promise<CryptoKey | null> {
  keyPromise ??= (async () => {
    const db = await openDb()
    if (!db) return null
    const read = db.transaction(META).objectStore(META).get(KEY_ID)
    const existing = (await promisify(read)) as CryptoKey | undefined
    if (existing) return existing
    if (!enabled) return null
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])
    try {
      const tx = db.transaction(META, 'readwrite')
      tx.objectStore(META).add(key, KEY_ID)
      await done(tx)
      return key
    } catch {
      // Another tab was faster: use its key.
      const again = db.transaction(META).objectStore(META).get(KEY_ID)
      return ((await promisify(again)) as CryptoKey | undefined) ?? null
    }
  })().catch(() => null)
  const key = await keyPromise
  // Not created yet: ask again next time (e.g. after login).
  if (!key) keyPromise = null
  return key
}

/** Allows writes again (called once a session is confirmed by the server). */
export function enableOfflineData(): void {
  cleared = false
  enabled = true
}

/** Whether the offline store is usable on this device. */
export function offlineStoreSupported(): boolean {
  return supported()
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb()
    const cryptoKey = db && (await cacheKey())
    if (!db || !cryptoKey) return null
    const record = (await promisify(
      db.transaction(ENTRY_DATA).objectStore(ENTRY_DATA).get(key),
    )) as EntryData | undefined
    if (!record) return null
    let value: T
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: record.iv, additionalData: new TextEncoder().encode(key) },
        cryptoKey,
        record.data,
      )
      value = JSON.parse(new TextDecoder().decode(plain)) as T
    } catch {
      // Unreadable (e.g. key replaced meanwhile): drop the entry.
      void cacheDelete(key)
      return null
    }
    if (enabled) void touch(db, key)
    return value
  } catch {
    return null
  }
}

async function touch(db: IDBDatabase, key: string): Promise<void> {
  try {
    const tx = db.transaction(ENTRY_META, 'readwrite')
    const store = tx.objectStore(ENTRY_META)
    const meta = (await promisify(store.get(key))) as EntryMeta | undefined
    if (meta) store.put({ ...meta, accessedAt: Date.now() })
    await done(tx)
  } catch {
    // LRU order is best effort.
  }
}

export async function cachePut(
  key: string,
  value: unknown,
  options: PutOptions = {},
): Promise<void> {
  if (!enabled) return
  try {
    const db = await openDb()
    const cryptoKey = db && (await cacheKey())
    if (!db || !cryptoKey || !enabled) return
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(key) },
      cryptoKey,
      new TextEncoder().encode(JSON.stringify(value)),
    )
    if (data.byteLength > MAX_ENTRY_BYTES || !enabled) return
    const meta: EntryMeta = {
      key,
      size: data.byteLength,
      accessedAt: Date.now(),
      pinned: options.pinned ?? false,
      accountId: options.accountId ?? null,
    }
    const tx = db.transaction([ENTRY_META, ENTRY_DATA], 'readwrite')
    tx.objectStore(ENTRY_META).put(meta)
    tx.objectStore(ENTRY_DATA).put({ key, iv, data } satisfies EntryData)
    await done(tx)
    scheduleEviction()
  } catch {
    // Quota exceeded or storage gone: the app keeps working from the network.
    scheduleEviction()
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    const db = await openDb()
    if (!db) return
    const tx = db.transaction([ENTRY_META, ENTRY_DATA], 'readwrite')
    tx.objectStore(ENTRY_META).delete(key)
    tx.objectStore(ENTRY_DATA).delete(key)
    await done(tx)
  } catch {
    // ignore
  }
}

/** Removes everything cached for a mail account (account deleted). */
export async function cacheDeleteAccount(accountId: string): Promise<void> {
  try {
    const db = await openDb()
    if (!db) return
    const tx = db.transaction([ENTRY_META, ENTRY_DATA], 'readwrite')
    const keys = await promisify(
      tx.objectStore(ENTRY_META).index('accountId').getAllKeys(IDBKeyRange.only(accountId)),
    )
    for (const key of keys) {
      tx.objectStore(ENTRY_META).delete(key)
      tx.objectStore(ENTRY_DATA).delete(key)
    }
    await done(tx)
  } catch {
    // ignore
  }
}

function scheduleEviction(): void {
  clearTimeout(evictTimer)
  evictTimer = setTimeout(() => void evict(), EVICT_DELAY_MS)
}

async function evict(): Promise<void> {
  try {
    const db = await openDb()
    if (!db) return
    const metas = (await promisify(
      db.transaction(ENTRY_META).objectStore(ENTRY_META).getAll(),
    )) as EntryMeta[]
    const evicted = selectEvictions(metas, DEFAULT_CACHE_LIMITS)
    if (evicted.length === 0) return
    const tx = db.transaction([ENTRY_META, ENTRY_DATA], 'readwrite')
    for (const key of evicted) {
      tx.objectStore(ENTRY_META).delete(key)
      tx.objectStore(ENTRY_DATA).delete(key)
    }
    await done(tx)
  } catch {
    // ignore
  }
}

/**
 * Deletes all offline data of this device: cache, queue and the key
 * (logout, session expired or revoked, another user). Writes stay disabled
 * until enableOfflineData() is called after the next login.
 */
export async function clearOfflineData(): Promise<void> {
  enabled = false
  clearTimeout(evictTimer)
  if (!supported()) return
  try {
    // Destroy the key first: even if deleting the database is delayed or
    // fails, what is left can no longer be decrypted.
    const db = await openDb()
    cleared = true
    if (db) {
      const tx = db.transaction([META, ENTRY_META, ENTRY_DATA], 'readwrite')
      tx.objectStore(META).clear()
      tx.objectStore(ENTRY_META).clear()
      tx.objectStore(ENTRY_DATA).clear()
      await done(tx).catch(() => {})
      db.close()
    }
  } catch {
    // ignore, the database is deleted below anyway
  }
  cleared = true
  dbPromise = null
  keyPromise = null
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}
