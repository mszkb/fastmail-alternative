package net.fma.mail.domain

/** What the app keeps after login: instance, device token, user. */
data class StoredSession(val baseUrl: String, val token: String, val email: String)

/**
 * Secure storage of the session (Android: EncryptedSharedPreferences backed
 * by the Keystore; iOS later: Keychain). Mail data is never stored (no
 * persistent cache yet, #145).
 */
interface SessionStore {
    fun load(): StoredSession?
    fun save(session: StoredSession)
    fun clear()

    /** The last instance address, kept after logout to prefill the form. */
    fun lastBaseUrl(): String?
}

class InMemorySessionStore(private var session: StoredSession? = null) : SessionStore {
    private var last: String? = session?.baseUrl
    override fun load() = session
    override fun save(session: StoredSession) {
        this.session = session
        last = session.baseUrl
    }
    override fun clear() {
        session = null
    }
    override fun lastBaseUrl() = last
}
