package net.fma.mail.android

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.suspendCancellableCoroutine
import net.fma.mail.api.ApiException
import net.fma.mail.api.FmaApi
import net.fma.mail.ui.PushController
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * Push for Android (#158):
 * - FCM when the app was built with a Firebase config and the server has
 *   FCM configured (#139): the token is registered as transport `fcm` and
 *   re-registered when it changes (FcmService.onNewToken);
 * - otherwise a STOPGAP: WorkManager polls the unread counts every 15 min
 *   (PollWorker) and shows the same generic notification.
 * Logout unregisters the token on the server and stops polling.
 */
class AndroidPush(private val context: Context) : PushController {
    /** Asks for POST_NOTIFICATIONS (Android 13+); set by MainActivity. */
    var requestPermission: suspend () -> Boolean = { Notifications.canNotify(context) }

    @Volatile private var mode: String = "Noch nicht eingerichtet."

    private val store get() = SecureSessionStore.get(context)

    override suspend fun register(api: FmaApi) {
        val allowed = requestPermission()
        val token = fcmToken()
        if (token != null) {
            try {
                api.registerFcm(token)
                store.fcmToken = token
                WorkManager.getInstance(context).cancelUniqueWork(PollWorker.NAME)
                mode = "Push über Firebase Cloud Messaging aktiv."
                if (!allowed) mode += " Benachrichtigungen sind in den Systemeinstellungen aus."
                return
            } catch (e: ApiException) {
                if (e.isUnauthorized) return
                mode = if (e.status == 422) "Der Server hat FCM nicht eingerichtet." else "FCM-Registrierung fehlgeschlagen (HTTP ${e.status})."
            } catch (e: Exception) {
                mode = "FCM-Registrierung fehlgeschlagen (offline?)."
            }
        } else {
            mode = "App ohne Firebase gebaut."
        }
        schedulePolling(context)
        mode += " Notlösung aktiv: Abfrage alle 15 Minuten."
        if (!allowed) mode += " Benachrichtigungen sind in den Systemeinstellungen aus."
    }

    override suspend fun unregister(api: FmaApi) {
        WorkManager.getInstance(context).cancelUniqueWork(PollWorker.NAME)
        PollWorker.reset(context)
        Notifications.clear(context)
        val token = store.fcmToken ?: return
        store.fcmToken = null
        try {
            api.unregisterPush(token)
        } catch (_: Exception) {
            // The server drops the subscriptions of a logged-out device anyway.
        }
        if (firebaseAvailable(context)) runCatching { FirebaseMessaging.getInstance().deleteToken() }
    }

    override fun status(): String = mode

    private suspend fun fcmToken(): String? {
        if (!firebaseAvailable(context)) return null
        return suspendCancellableCoroutine { cont ->
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                cont.resume(if (task.isSuccessful) task.result else null)
            }
        }
    }

    companion object {
        fun firebaseAvailable(context: Context): Boolean = FirebaseApp.getApps(context).isNotEmpty()

        fun schedulePolling(context: Context) {
            val request = PeriodicWorkRequestBuilder<PollWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(PollWorker.NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
