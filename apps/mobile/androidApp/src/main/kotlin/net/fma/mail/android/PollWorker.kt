package net.fma.mail.android

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import net.fma.mail.api.ApiException
import net.fma.mail.api.FmaApi
import net.fma.mail.domain.accountsWithNewMail
import net.fma.mail.domain.badgeCount

/**
 * STOPGAP without FCM (#158): every 15 minutes the unread INBOX counts are
 * fetched; when one grew, the generic "Neue E-Mail" notification is shown.
 * Only counts per account id are stored, no mail content.
 */
class PollWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val session = SecureSessionStore.get(applicationContext).load() ?: return Result.success()
        val api = FmaApi(session.baseUrl, { session.token })
        return try {
            val accounts = api.accounts()
            val prefs = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val previous = accounts.associate { it.id to prefs.getInt(it.id, -1) }.filterValues { it >= 0 }
            if (previous.isNotEmpty() && accountsWithNewMail(previous, accounts).isNotEmpty()) {
                Notifications.showNewMail(applicationContext, badgeCount(accounts))
            }
            val editor = prefs.edit().clear()
            accounts.forEach { editor.putInt(it.id, it.unreadCount) }
            editor.apply()
            Result.success()
        } catch (e: ApiException) {
            if (e.isUnauthorized) {
                // Token revoked: stop polling until the next login.
                WorkManager.getInstance(applicationContext).cancelUniqueWork(NAME)
                Result.success()
            } else {
                Result.retry()
            }
        } catch (e: Exception) {
            Result.retry()
        } finally {
            api.close()
        }
    }

    companion object {
        const val NAME = "fma-poll"
        private const val PREFS = "fma_poll_counts"

        fun reset(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }
}
