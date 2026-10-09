package net.fma.mail.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import net.fma.mail.R

/**
 * Local notification for new mail: always the generic text "Neue E-Mail",
 * never sender or subject (principle 4). Tapping opens the inbox and syncs.
 */
object Notifications {
    const val CHANNEL_NEW_MAIL = "new_mail"
    const val EXTRA_OPEN_INBOX = "net.fma.mail.OPEN_INBOX"
    private const val ID_NEW_MAIL = 1

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_NEW_MAIL,
            context.getString(R.string.channel_new_mail),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { setShowBadge(true) }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun canNotify(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun showNewMail(context: Context, badge: Int?) {
        if (!canNotify(context)) return
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_OPEN_INBOX, true)
        val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, CHANNEL_NEW_MAIL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.notification_new_mail))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .apply { if (badge != null && badge > 0) setNumber(badge) }
            .build()
        try {
            NotificationManagerCompat.from(context).notify(ID_NEW_MAIL, notification)
        } catch (_: SecurityException) {
            // Permission revoked meanwhile.
        }
    }

    fun clear(context: Context) = NotificationManagerCompat.from(context).cancel(ID_NEW_MAIL)
}
