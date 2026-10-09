package net.fma.mail.android

import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.runtime.Composable
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.headersOf
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import net.fma.mail.api.FmaApi
import net.fma.mail.domain.InMemorySessionStore
import net.fma.mail.domain.SessionStore
import net.fma.mail.ui.App
import net.fma.mail.ui.Platform
import net.fma.mail.ui.PushController
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections

/**
 * The whole UI against a fake server (Ktor MockEngine): connect, login,
 * list, read in the WebView, archive, compose and send. Verifies the
 * requests the app makes, including the Bearer token.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class MailFlowTest {
    @get:Rule
    val compose = createComposeRule()

    private val requests: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val bodies: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private var archived = false

    private val engine = MockEngine { request ->
        val path = request.url.encodedPath
        val body = (request.body as? OutgoingContent.ByteArrayContent)?.bytes()?.decodeToString().orEmpty()
        requests += "${request.method.value} $path"
        if (body.isNotEmpty()) bodies += body
        if (path != "/api/health" && path != "/api/auth/login") {
            assertEquals("Bearer test-token", request.headers[HttpHeaders.Authorization])
        }
        val json = when {
            path == "/api/health" -> """{"status":"ok","service":"api","version":"test"}"""
            path == "/api/auth/login" -> """{"email":"me@example.org","token":"test-token"}"""
            path == "/api/accounts" -> """{"accounts":[{"id":"a1","displayName":"Arbeit","emailAddress":"me@example.org",
                "status":"ok","unreadCount":1,"syncing":false,"lastSyncAt":"2026-10-09T10:00:00Z"}]}"""
            path == "/api/sync" -> """{"accounts":[{"accountId":"a1","queued":true,"reason":null}]}"""
            path == "/api/accounts/a1/folders" -> """{"folders":[
                {"id":"f1","name":"INBOX","path":"INBOX","depth":0,"specialUse":"inbox","selectable":true,"unreadCount":1,"total":1},
                {"id":"f2","name":"Archive","path":"Archive","depth":0,"specialUse":"archive","selectable":true,"unreadCount":0,"total":0}]}"""
            path == "/api/folders/f1/messages" -> if (archived) {
                """{"messages":[],"nextCursor":null}"""
            } else {
                """{"messages":[{"id":"m1","subject":"Hallo Welt","from":{"name":"Ann","address":"ann@example.org"},
                "date":"2026-10-09T10:00:00Z","snippet":"Vorschau","flags":{"seen":false,"flagged":false,"answered":false},
                "hasAttachments":false,"threadId":null,"threadCount":1}],"nextCursor":null}"""
            }
            path == "/api/messages/m1" -> """{"id":"m1","accountId":"a1","folderIds":["f1"],"subject":"Hallo Welt",
                "from":{"name":"Ann","address":"ann@example.org"},"to":[{"name":"","address":"me@example.org"}],"cc":[],
                "replyTo":[],"date":"2026-10-09T10:00:00Z","flags":{"seen":false,"flagged":false,"answered":false},
                "hasAttachments":false,"messageId":"<m1@example.org>","references":[],"text":"Text","threadId":null}"""
            path == "/api/messages/m1/html" -> """{"html":"<p>Inhalt der Mail</p>","remoteContentBlocked":false}"""
            path == "/api/messages/actions" -> {
                if (body.contains("\"archive\"")) archived = true
                """{"updated":1}"""
            }
            path == "/api/accounts/a1/identities" -> """{"identities":[{"id":"i1","name":"Me","emailAddress":"me@example.org",
                "signature":null,"isDefault":true}]}"""
            path == "/api/outbox" && request.method == HttpMethod.Post ->
                """{"id":"o1","accountId":"a1","status":"queued","error":null}"""
            else -> return@MockEngine respond("""{"message":"not found"}""", HttpStatusCode.NotFound, jsonHeaders)
        }
        respond(json, HttpStatusCode.OK, jsonHeaders)
    }

    private val platform = object : Platform {
        override val sessionStore: SessionStore = InMemorySessionStore()
        override val deviceName = "Test device"
        override val platformName = "android"
        override val push = object : PushController {
            override suspend fun register(api: FmaApi) = Unit
            override suspend fun unregister(api: FmaApi) = Unit
            override fun status() = "Test"
        }
        override val openInboxRequests: Flow<Unit> = MutableSharedFlow()
        override val httpEngine: HttpClientEngine = engine
        override fun openExternal(url: String) = Unit

        @Composable
        override fun HtmlView(html: String, allowRemote: Boolean, onLink: (String) -> Unit, modifier: Modifier) =
            LockedWebView(html, allowRemote, onLink, modifier)
    }

    /** Waits for a text; on timeout the message carries the screen's semantics tree and the requests so far. */
    private fun waitFor(text: String) {
        try {
            compose.waitUntilAtLeastOneExists(hasText(text, substring = true), 10_000)
        } catch (e: Throwable) {
            // One line: Gradle prints only the first lines of a failure message.
            val texts = runCatching {
                compose.onAllNodes(SemanticsMatcher("any") { true }, useUnmergedTree = true).fetchSemanticsNodes()
                    .flatMap { node ->
                        node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } +
                            node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty()
                    }
                    .filter { it.isNotBlank() }
            }.getOrDefault(emptyList())
            throw AssertionError("'$text' not shown. Screen: ${texts.joinToString(" | ")} -- Requests: $requests", e)
        }
    }

    @Test
    fun loginReadArchiveAndSend() {
        compose.setContent { App(platform) }

        compose.onNodeWithText("Adresse der Instanz").performTextInput("mail.test")
        compose.onNodeWithText("Weiter").performClick()
        waitFor("E-Mail-Adresse")
        compose.onNodeWithText("E-Mail-Adresse").performTextInput("me@example.org")
        compose.onNodeWithText("Passwort").performTextInput("secret-password")
        compose.onNodeWithText("Anmelden").performClick()

        waitFor("Hallo Welt")
        assertTrue(requests.contains("POST /api/sync"))
        compose.onNodeWithText("Hallo Welt").performClick()
        waitFor("An: me@example.org")
        compose.waitUntil(10_000) { bodies.any { it.contains("\"read\"") } }

        compose.onNodeWithContentDescription("Archivieren").performClick()
        compose.waitUntil(10_000) { archived }
        waitFor("Keine Nachrichten")

        compose.onNodeWithContentDescription("Verfassen").performClick()
        compose.waitUntilAtLeastOneExists(hasText("me@example.org", substring = true), 10_000)
        compose.onNodeWithText("An").performTextInput("bob@example.org")
        compose.onNodeWithText("Betreff").performTextInput("Test")
        compose.onNodeWithText("Nachricht").performTextInput("Hallo Bob")
        compose.waitUntilAtLeastOneExists(hasContentDescription("Senden"), 5_000)
        compose.onNodeWithContentDescription("Senden").performClick()
        compose.waitUntil(10_000) { requests.contains("POST /api/outbox") }
        val sent = bodies.last { it.contains("bob@example.org") }
        assertTrue(sent, sent.contains("\"identityId\":\"i1\"") && sent.contains("\"subject\":\"Test\""))
        waitFor("Keine Nachrichten")
    }

    private companion object {
        val jsonHeaders = headersOf(HttpHeaders.ContentType, "application/json")
    }
}
