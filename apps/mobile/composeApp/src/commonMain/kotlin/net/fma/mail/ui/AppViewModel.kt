package net.fma.mail.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import net.fma.mail.api.AccountSummary
import net.fma.mail.api.ApiException
import net.fma.mail.api.FmaApi
import net.fma.mail.api.FolderSummary
import net.fma.mail.api.InstanceUrl
import net.fma.mail.api.MessageListItem
import net.fma.mail.domain.StoredSession
import net.fma.mail.domain.SyncThrottle
import kotlin.time.Clock
import kotlin.time.ExperimentalTime

data class MailState(
    val accounts: List<AccountSummary> = emptyList(),
    val selectedAccountId: String? = null,
    val folders: List<FolderSummary> = emptyList(),
    val selectedFolderId: String? = null,
    val messages: List<MessageListItem> = emptyList(),
    val nextCursor: String? = null,
    val loadingMessages: Boolean = false,
    val loadingMore: Boolean = false,
    val refreshing: Boolean = false,
    val error: String? = null,
) {
    val selectedAccount: AccountSummary? get() = accounts.firstOrNull { it.id == selectedAccountId }
    val selectedFolder: FolderSummary? get() = folders.firstOrNull { it.id == selectedFolderId }
}

/**
 * App state: session, the active account/folder and its message list. Mail
 * data lives only in memory (no persistent cache yet, #145); the server is
 * the source of truth. Accounts stay separate (principle 8): exactly one
 * account is shown at a time.
 */
@OptIn(ExperimentalTime::class)
class AppViewModel(private val platform: Platform) : ViewModel() {
    private val _session = MutableStateFlow(platform.sessionStore.load())
    val session: StateFlow<StoredSession?> = _session.asStateFlow()

    private val _mail = MutableStateFlow(MailState())
    val mail: StateFlow<MailState> = _mail.asStateFlow()

    var api: FmaApi? = _session.value?.let { createApi(it.baseUrl) }
        private set

    private val throttle = SyncThrottle()
    private var pollJob: Job? = null

    init {
        if (_session.value != null) {
            viewModelScope.launch { api?.let { runCatching { platform.push.register(it) } } }
        }
    }

    private fun createApi(baseUrl: String) = FmaApi(
        baseUrl = baseUrl,
        token = { _session.value?.token },
        onUnauthorized = { onRevoked() },
    )

    private fun now() = Clock.System.now().toEpochMilliseconds()

    // --- connect / login / logout -----------------------------------------

    fun lastBaseUrl(): String = platform.sessionStore.lastBaseUrl().orEmpty()

    /** Checks the address and /api/health; returns the base URL or an error text. */
    suspend fun checkInstance(input: String): Result<String> {
        val normalized = when (val result = InstanceUrl.normalize(input)) {
            is InstanceUrl.Result.Invalid -> return Result.failure(IllegalArgumentException(result.reason))
            is InstanceUrl.Result.Ok -> result.baseUrl
        }
        val probe = FmaApi(normalized, { null })
        return try {
            val health = probe.health()
            if (health.status != "ok") {
                Result.failure(IllegalStateException("Die Instanz meldet ein Problem (${health.status})."))
            } else {
                Result.success(normalized)
            }
        } catch (e: ApiException) {
            Result.failure(IllegalStateException("Keine fastmail-alternative-Instanz unter dieser Adresse (HTTP ${e.status})."))
        } catch (e: Exception) {
            Result.failure(IllegalStateException(connectionErrorText(e)))
        } finally {
            probe.close()
        }
    }

    suspend fun login(baseUrl: String, email: String, password: String): String? {
        val probe = FmaApi(baseUrl, { null })
        try {
            val response = probe.login(email.trim(), password, platform.deviceName, platform.platformName)
            val token = response.token ?: return "Der Server unterstützt keine App-Anmeldung (bitte Server aktualisieren)."
            val session = StoredSession(baseUrl, token, response.email)
            platform.sessionStore.save(session)
            api?.close()
            _session.value = session
            api = createApi(baseUrl)
            _mail.value = MailState()
            viewModelScope.launch { api?.let { runCatching { platform.push.register(it) } } }
            return null
        } catch (e: ApiException) {
            return when (e.status) {
                401 -> "E-Mail-Adresse oder Passwort ist falsch."
                429 -> e.message
                else -> "Anmeldung fehlgeschlagen: ${e.message}"
            }
        } catch (e: Exception) {
            return connectionErrorText(e)
        } finally {
            probe.close()
        }
    }

    fun logout() {
        val current = api
        viewModelScope.launch {
            if (current != null) {
                runCatching { platform.push.unregister(current) }
                runCatching { current.logout() }
            }
            clearSession()
        }
    }

    /** 401 from the server: token revoked or expired. */
    private fun onRevoked() {
        if (_session.value == null) return
        viewModelScope.launch {
            api?.let { runCatching { platform.push.unregister(it) } }
            clearSession()
        }
    }

    private fun clearSession() {
        pollJob?.cancel()
        platform.sessionStore.clear()
        _session.value = null
        _mail.value = MailState()
        api?.close()
        api = null
    }

    // --- sync / accounts ----------------------------------------------------

    /** App start, return to the foreground, notification tap (force), pull-to-refresh (force). */
    fun foregroundSync(force: Boolean = false) {
        val api = api ?: return
        if (!throttle.shouldSync(now(), force)) return
        viewModelScope.launch {
            runCatching { api.syncAll() }
            refreshAccounts()
            startPolling()
        }
    }

    private fun startPolling() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            val until = now() + SyncThrottle.POLL_WINDOW_MILLIS
            while (now() < until) {
                delay(SyncThrottle.POLL_INTERVAL_MILLIS)
                val accounts = refreshAccounts() ?: break
                if (accounts.none { it.syncing }) break
            }
        }
    }

    /** Reloads the account list; reloads folders and the first page when the active account changed. */
    suspend fun refreshAccounts(): List<AccountSummary>? {
        val api = api ?: return null
        val accounts = try {
            api.accounts()
        } catch (e: Exception) {
            showError(e)
            return null
        }
        val before = _mail.value.selectedAccount
        val selected = _mail.value.selectedAccountId?.takeIf { id -> accounts.any { it.id == id } }
            ?: accounts.firstOrNull()?.id
        _mail.update { it.copy(accounts = accounts, selectedAccountId = selected) }
        val after = _mail.value.selectedAccount
        when {
            selected == null -> Unit
            _mail.value.folders.isEmpty() || before?.id != selected -> loadFolders(selected)
            before?.lastSyncAt != after?.lastSyncAt || before?.unreadCount != after?.unreadCount ||
                (before?.syncing == true && after?.syncing == false) -> {
                reloadFolderCounts(selected)
                reloadFirstPage()
            }
        }
        return accounts
    }

    fun selectAccount(accountId: String) {
        if (accountId == _mail.value.selectedAccountId) return
        _mail.update { it.copy(selectedAccountId = accountId, folders = emptyList(), selectedFolderId = null, messages = emptyList(), nextCursor = null) }
        viewModelScope.launch { loadFolders(accountId) }
    }

    private suspend fun loadFolders(accountId: String) {
        val api = api ?: return
        try {
            val folders = api.folders(accountId)
            if (_mail.value.selectedAccountId != accountId) return
            val inbox = folders.firstOrNull { it.specialUse == "inbox" } ?: folders.firstOrNull { it.selectable }
            val keep = _mail.value.selectedFolderId?.takeIf { id -> folders.any { it.id == id } }
            _mail.update { it.copy(folders = folders, selectedFolderId = keep ?: inbox?.id) }
            reloadFirstPage(replace = keep == null)
        } catch (e: Exception) {
            showError(e)
        }
    }

    private suspend fun reloadFolderCounts(accountId: String) {
        val folders = runCatching { api?.folders(accountId) }.getOrNull() ?: return
        if (_mail.value.selectedAccountId == accountId) _mail.update { it.copy(folders = folders) }
    }

    fun selectFolder(folderId: String) {
        _mail.update { it.copy(selectedFolderId = folderId, messages = emptyList(), nextCursor = null) }
        viewModelScope.launch { reloadFirstPage(replace = true) }
    }

    /** Shows the INBOX of the active account (notification tap). */
    fun showInbox() {
        val inbox = _mail.value.folders.firstOrNull { it.specialUse == "inbox" } ?: return
        if (inbox.id != _mail.value.selectedFolderId) selectFolder(inbox.id)
    }

    // --- messages ---------------------------------------------------------

    /**
     * Loads the newest page. Without [replace] it is merged with what is
     * shown: pages loaded further down stay (by date), so scrolling keeps
     * its place.
     */
    suspend fun reloadFirstPage(replace: Boolean = false) {
        val api = api ?: return
        val folderId = _mail.value.selectedFolderId ?: return
        if (replace) _mail.update { it.copy(loadingMessages = true) }
        try {
            val page = api.messages(folderId)
            if (_mail.value.selectedFolderId != folderId) return
            _mail.update { state ->
                val oldest = page.messages.lastOrNull()?.date
                val older = if (replace || page.nextCursor == null || oldest == null) {
                    emptyList()
                } else {
                    state.messages.filter { it.date < oldest && page.messages.none { p -> p.id == it.id } }
                }
                state.copy(
                    messages = page.messages + older,
                    nextCursor = if (older.isEmpty()) page.nextCursor else state.nextCursor,
                    loadingMessages = false,
                    error = null,
                )
            }
        } catch (e: Exception) {
            _mail.update { it.copy(loadingMessages = false) }
            showError(e)
        }
    }

    fun loadMore() {
        val state = _mail.value
        val cursor = state.nextCursor ?: return
        val folderId = state.selectedFolderId ?: return
        if (state.loadingMore) return
        _mail.update { it.copy(loadingMore = true) }
        viewModelScope.launch {
            try {
                val page = api?.messages(folderId, cursor) ?: return@launch
                if (_mail.value.selectedFolderId != folderId) return@launch
                _mail.update { s ->
                    s.copy(
                        messages = s.messages + page.messages.filter { m -> s.messages.none { it.id == m.id } },
                        nextCursor = page.nextCursor,
                    )
                }
            } catch (e: Exception) {
                showError(e)
            } finally {
                _mail.update { it.copy(loadingMore = false) }
            }
        }
    }

    fun refresh() {
        _mail.update { it.copy(refreshing = true) }
        viewModelScope.launch {
            foregroundSync(force = true)
            reloadFirstPage()
            _mail.update { it.copy(refreshing = false) }
        }
    }

    /**
     * read/unread/flag/unflag/archive/delete, optimistic in the list; on
     * failure the list is reloaded from the server.
     */
    fun messageAction(messageId: String, action: String, folderId: String? = null, onDone: (String?) -> Unit = {}) {
        val api = api ?: return
        val folder = folderId ?: _mail.value.selectedFolderId ?: return
        applyLocally(messageId, action)
        viewModelScope.launch {
            try {
                api.messageAction(folder, listOf(messageId), action)
                onDone(null)
                refreshAccounts()
            } catch (e: Exception) {
                reloadFirstPage()
                val text = errorText(e)
                showError(e)
                onDone(text)
            }
        }
    }

    private fun applyLocally(messageId: String, action: String) {
        _mail.update { state ->
            val messages = when (action) {
                "archive", "delete" -> state.messages.filterNot { it.id == messageId }
                else -> state.messages.map { m ->
                    if (m.id != messageId) {
                        m
                    } else {
                        when (action) {
                            "read" -> m.copy(flags = m.flags.copy(seen = true))
                            "unread" -> m.copy(flags = m.flags.copy(seen = false))
                            "flag" -> m.copy(flags = m.flags.copy(flagged = true))
                            "unflag" -> m.copy(flags = m.flags.copy(flagged = false))
                            else -> m
                        }
                    }
                }
            }
            state.copy(messages = messages)
        }
    }

    fun markReadLocally(messageId: String) = applyLocally(messageId, "read")

    fun clearError() = _mail.update { it.copy(error = null) }

    private fun showError(e: Exception) {
        if (e is ApiException && e.isUnauthorized) return
        _mail.update { it.copy(error = errorText(e)) }
    }

    override fun onCleared() {
        api?.close()
    }

    companion object {
        fun errorText(e: Exception): String = when (e) {
            is ApiException -> when (e.status) {
                409 -> "Aktion nicht möglich: ${e.message}"
                429 -> "Zu viele Anfragen, bitte kurz warten."
                else -> e.message
            }
            else -> connectionErrorText(e)
        }

        fun connectionErrorText(e: Exception): String {
            val text = (e.message ?: e::class.simpleName).orEmpty()
            return when {
                text.contains("cert", ignoreCase = true) || text.contains("SSL", ignoreCase = true) ||
                    text.contains("TLS", ignoreCase = true) ->
                    "Das TLS-Zertifikat der Instanz ist ungültig oder nicht vertrauenswürdig."
                text.contains("resolve", ignoreCase = true) || text.contains("host", ignoreCase = true) ->
                    "Server nicht gefunden. Adresse prüfen."
                text.contains("timeout", ignoreCase = true) || text.contains("timed out", ignoreCase = true) ->
                    "Zeitüberschreitung beim Verbinden."
                else -> "Verbindung fehlgeschlagen. Bist du online?"
            }
        }
    }
}
