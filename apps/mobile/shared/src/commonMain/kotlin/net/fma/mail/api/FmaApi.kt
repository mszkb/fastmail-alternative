package net.fma.mail.api

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.call.body
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import net.fma.mail.httpEngine

/** A non-2xx answer of the API; `message` is the server's ErrorMessage text. */
class ApiException(val status: Int, override val message: String, val retryAfterSeconds: Int? = null) : Exception(message) {
    val isUnauthorized: Boolean get() = status == 401
}

/**
 * Thin Ktor client for the instance API (#143). Authenticates with the
 * device token as `Authorization: Bearer` (#138), never with cookies.
 * Every 401 calls [onUnauthorized] (token revoked or expired: the app logs
 * out and drops its in-memory data).
 */
class FmaApi(
    val baseUrl: String,
    private val token: () -> String?,
    private val onUnauthorized: suspend () -> Unit = {},
    engine: HttpClientEngine? = null,
) {
    private val client: HttpClient = if (engine != null) HttpClient(engine) { setup() } else HttpClient(httpEngine()) { setup() }

    private fun HttpClientConfig<*>.setup() {
        expectSuccess = false
        followRedirects = false
        install(ContentNegotiation) { json(json) }
        install(HttpTimeout) {
            requestTimeoutMillis = 30_000
            connectTimeoutMillis = 15_000
        }
        defaultRequest { url(baseUrl.trimEnd('/') + "/") }
    }

    fun close() = client.close()

    private suspend inline fun <reified T> HttpResponse.read(): T {
        check(this)
        return body()
    }

    private suspend fun check(response: HttpResponse) {
        if (response.status.isSuccess()) return
        val message = runCatching { json.decodeFromString(ErrorMessage.serializer(), response.bodyAsText()).message }
            .getOrNull().orEmpty()
        if (response.status.value == 401) onUnauthorized()
        throw ApiException(
            response.status.value,
            message.ifBlank { "HTTP ${response.status.value}" },
            response.headers["Retry-After"]?.toIntOrNull(),
        )
    }

    private fun HttpRequestBuilder.auth() {
        token()?.let { bearerAuth(it) }
    }

    private fun HttpRequestBuilder.jsonBody(body: Any) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    // --- system / auth ---------------------------------------------------

    suspend fun health(): HealthStatus = client.get("api/health").read()

    suspend fun authStatus(): AuthStatus = client.get("api/auth/status") { auth() }.read()

    suspend fun login(email: String, password: String, deviceName: String, platform: String): LoginResponse =
        client.post("api/auth/login") { jsonBody(LoginRequest(email, password, deviceName, platform)) }.read()

    /** First-run setup of a fresh instance (setup code from the server log); sets a cookie, used by tests. */
    suspend fun setup(email: String, password: String, setupCode: String) = check(
        client.post("api/auth/setup") { jsonBody(SetupRequest(email, password, setupCode)) },
    )

    suspend fun logout() = check(client.delete("api/auth/session") { auth() })

    suspend fun devices(): List<DeviceInfo> = client.get("api/auth/devices") { auth() }.read<DeviceListResponse>().devices

    // --- accounts / sync ---------------------------------------------------

    suspend fun accounts(): List<AccountSummary> = client.get("api/accounts") { auth() }.read<AccountListResponse>().accounts

    suspend fun syncAll(): SyncResponse = client.post("api/sync") { auth() }.read()

    suspend fun syncStatus(): List<AccountSyncStatus> = client.get("api/sync/status") { auth() }.read<SyncStatusResponse>().accounts

    // --- folders / messages -----------------------------------------------

    suspend fun folders(accountId: String): List<FolderSummary> =
        client.get("api/accounts/$accountId/folders") { auth() }.read<FolderListResponse>().folders

    suspend fun messages(folderId: String, cursor: String? = null, limit: Int = 50): MessagePage =
        client.get("api/folders/$folderId/messages") {
            auth()
            parameter("limit", limit)
            cursor?.let { parameter("cursor", it) }
        }.read()

    suspend fun loadOlder(folderId: String): LoadOlderResponse = client.post("api/folders/$folderId/load-older") { auth() }.read()

    /** IMAP SEARCH at the provider (#152), newest first, at most 100; the query is never logged by the server. */
    suspend fun search(accountId: String, query: String, folderId: String? = null): SearchResponse =
        client.get("api/accounts/$accountId/search") {
            auth()
            parameter("q", query.trim().take(200))
            folderId?.let { parameter("folderId", it) }
        }.read()

    suspend fun message(id: String): MessageDetail = client.get("api/messages/$id") { auth() }.read()

    /** Sanitized HTML; remote images stay blocked unless [remote]. */
    suspend fun messageHtml(id: String, remote: Boolean = false): MessageHtml =
        client.get("api/messages/$id/html") {
            auth()
            parameter("remote", if (remote) "1" else "0")
        }.read()

    suspend fun messageAction(folderId: String, messageIds: List<String>, action: String, targetFolderId: String? = null): Int =
        client.post("api/messages/actions") {
            auth()
            jsonBody(MessageActionRequest(folderId, messageIds, action, targetFolderId))
        }.read<MessageActionResponse>().updated

    // --- compose ----------------------------------------------------------

    suspend fun identities(accountId: String): List<ComposeIdentity> =
        client.get("api/accounts/$accountId/identities") { auth() }.read<IdentityListResponse>().identities

    suspend fun send(request: SendMessageRequest): OutboxMessage = client.post("api/outbox") {
        auth()
        jsonBody(request)
    }.read()

    // --- push -------------------------------------------------------------

    suspend fun registerFcm(token: String) = check(client.post("api/push/subscriptions") {
        auth()
        jsonBody(FcmSubscriptionRequest(token))
    })

    suspend fun unregisterPush(endpoint: String) = check(client.delete("api/push/subscriptions") {
        auth()
        jsonBody(PushUnsubscribeRequest(endpoint))
    })

    companion object {
        val json = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
            explicitNulls = false
            coerceInputValues = true
        }
    }
}
