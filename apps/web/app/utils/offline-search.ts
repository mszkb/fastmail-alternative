// Offline search (#162): reads the encrypted offline cache (folder lists,
// first list pages, opened messages and threads), decrypts it in memory and
// filters with searchOffline from @fma/shared. Nothing is written: no index,
// no search terms, no plaintext on disk.
import { searchOffline } from '@fma/shared'
import type {
  FolderSummary,
  GlobalSearchItem,
  MessageDetail,
  MessageListItem,
  OfflineFolder,
  OfflineListEntry,
  SearchQuery,
  ThreadDetail,
} from '@fma/shared'
import { cacheEntries } from './offline-store'

/** Hits are rendered windowed; this only bounds the work on huge caches. */
const MAX_OFFLINE_HITS = 1000

export interface CachedFolder extends OfflineFolder {
  folder: FolderSummary
}

/** Folders of all accounts as cached by the mail view (`folders:<accountId>`). */
export async function cachedFolders(): Promise<Map<string, CachedFolder>> {
  const folders = new Map<string, CachedFolder>()
  for (const { key, value } of await cacheEntries<FolderSummary[]>(['folders:'])) {
    const accountId = key.slice('folders:'.length)
    for (const folder of value) {
      folders.set(folder.id, { accountId, role: folder.specialUse, folder })
    }
  }
  return folders
}

export async function searchCachedMessages(
  query: SearchQuery,
  options: { accountIds?: string[]; folders?: Map<string, CachedFolder> } = {},
): Promise<GlobalSearchItem[]> {
  const folders = options.folders ?? (await cachedFolders())
  const lists: OfflineListEntry[] = []
  const details: MessageDetail[] = []
  const entries = await cacheEntries<
    { messages: MessageListItem[] } | MessageDetail | ThreadDetail
  >(['list:', 'msg:', 'thread:'])
  for (const { key, value } of entries) {
    if (key.startsWith('list:')) {
      const folder = folders.get(key.slice('list:'.length))
      if (!folder) continue
      for (const message of (value as { messages: MessageListItem[] }).messages ?? []) {
        lists.push({
          accountId: folder.accountId,
          folderId: folder.folder.id,
          folderRole: folder.role,
          message,
        })
      }
    } else if (key.startsWith('msg:')) {
      details.push(value as MessageDetail)
    } else {
      details.push(...((value as ThreadDetail).messages ?? []))
    }
  }
  return searchOffline(lists, details, folders, query, {
    accountIds: options.accountIds,
    limit: MAX_OFFLINE_HITS,
  })
}
