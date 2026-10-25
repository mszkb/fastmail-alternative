package net.fma.mail.android

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.launch
import net.fma.mail.api.FmaApi

/**
 * FCM (#158): data-only messages carry only {event, installationId, badge};
 * the notification text is generic. A new token is registered right away.
 */
class FcmService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["event"] != "new_mail") return
        val app = application as FmaApplication
        if (app.isInForeground) {
            app.syncNow.tryEmit(Unit)
            return
        }
        Notifications.showNewMail(this, message.data["badge"]?.toIntOrNull())
    }

    override fun onNewToken(token: String) {
        val store = SecureSessionStore.get(this)
        val session = store.load() ?: return
        val app = application as FmaApplication
        app.scope.launch {
            val api = FmaApi(session.baseUrl, { session.token })
            try {
                api.registerFcm(token)
                store.fcmToken = token
            } catch (_: Exception) {
                // Registered again on the next app start.
            } finally {
                api.close()
            }
        }
    }
}
