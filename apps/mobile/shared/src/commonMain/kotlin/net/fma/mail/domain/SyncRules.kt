package net.fma.mail.domain

import net.fma.mail.api.AccountSummary

/**
 * Foreground sync rules (docs/architecture/push.md, same as the PWA's
 * foreground-sync.ts): the app start always syncs, focus events at most
 * every 15 s; afterwards the account list is polled every 3 s while an
 * account is syncing, at most for 2 minutes.
 */
class SyncThrottle(private val minIntervalMillis: Long = 15_000) {
    private var last: Long? = null

    fun shouldSync(nowMillis: Long, force: Boolean = false): Boolean {
        val previous = last
        if (!force && previous != null && nowMillis - previous < minIntervalMillis) return false
        last = nowMillis
        return true
    }

    companion object {
        const val POLL_INTERVAL_MILLIS = 3_000L
        const val POLL_WINDOW_MILLIS = 120_000L
    }
}

/** Accounts as shown: sort order of the server, unread INBOX count as badge. */
fun badgeCount(accounts: List<AccountSummary>): Int = accounts.sumOf { it.unreadCount.coerceAtLeast(0) }

/**
 * Background fallback without FCM: new mail is assumed when the unread
 * INBOX count of an account grew since the last check. Returns the
 * accounts with more unread mail; [previous] maps account id to count.
 */
fun accountsWithNewMail(previous: Map<String, Int>, current: List<AccountSummary>): List<String> =
    current.filter { account -> previous[account.id]?.let { account.unreadCount > it } == true }.map { it.id }

/** Folder roles in display order, like the PWA's folder list. */
val FOLDER_ROLE_ORDER = listOf("inbox", "drafts", "sent", "archive", "junk", "trash")

fun folderRoleLabel(role: String?): String? = when (role) {
    "inbox" -> "Posteingang"
    "sent" -> "Gesendet"
    "drafts" -> "Entwürfe"
    "trash" -> "Papierkorb"
    "archive" -> "Archiv"
    "junk" -> "Spam"
    else -> null
}
