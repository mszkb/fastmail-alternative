package net.fma.mail.android

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import net.fma.mail.domain.SessionStore
import net.fma.mail.domain.StoredSession

/**
 * Session (instance URL, device token, email) in EncryptedSharedPreferences;
 * the key lives in the Android Keystore. Never logged, excluded from backups.
 */
class SecureSessionStore(context: Context) : SessionStore {
    private val prefs: SharedPreferences = open(context)

    override fun load(): StoredSession? {
        val baseUrl = prefs.getString(KEY_URL, null) ?: return null
        val token = prefs.getString(KEY_TOKEN, null) ?: return null
        return StoredSession(baseUrl, token, prefs.getString(KEY_EMAIL, null).orEmpty())
    }

    override fun save(session: StoredSession) {
        prefs.edit()
            .putString(KEY_URL, session.baseUrl)
            .putString(KEY_LAST_URL, session.baseUrl)
            .putString(KEY_TOKEN, session.token)
            .putString(KEY_EMAIL, session.email)
            .apply()
    }

    override fun clear() {
        prefs.edit().remove(KEY_URL).remove(KEY_TOKEN).remove(KEY_EMAIL).remove(KEY_FCM_TOKEN).apply()
    }

    override fun lastBaseUrl(): String? = prefs.getString(KEY_LAST_URL, null)

    /** The FCM token registered on the server, to unregister it on logout. */
    var fcmToken: String?
        get() = prefs.getString(KEY_FCM_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_FCM_TOKEN, value).apply()

    companion object {
        private const val FILE = "fma_secure"
        private const val KEY_URL = "base_url"
        private const val KEY_LAST_URL = "last_base_url"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_EMAIL = "email"
        private const val KEY_FCM_TOKEN = "fcm_token"

        @Volatile private var instance: SecureSessionStore? = null

        fun get(context: Context): SecureSessionStore =
            instance ?: synchronized(this) { instance ?: SecureSessionStore(context.applicationContext).also { instance = it } }

        private fun open(context: Context): SharedPreferences {
            val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            return try {
                create(context, key)
            } catch (e: Exception) {
                // Keystore entry lost (e.g. after a restore): start over, the user logs in again.
                context.deleteSharedPreferences(FILE)
                create(context, key)
            }
        }

        private fun create(context: Context, key: MasterKey) = EncryptedSharedPreferences.create(
            context,
            FILE,
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }
}
