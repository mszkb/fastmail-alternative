package net.fma.mail

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.fma.mail.api.ApiException
import net.fma.mail.api.FmaApi
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FmaApiTest {
    private val jsonHeaders = headersOf(HttpHeaders.ContentType, "application/json")
    private val requests = mutableListOf<HttpRequestData>()

    private fun api(token: String? = "tok", onUnauthorized: suspend () -> Unit = {}, handler: (HttpRequestData) -> Pair<HttpStatusCode, String>): FmaApi {
        val engine = MockEngine { request ->
            requests += request
            val (status, body) = handler(request)
            respond(body, status, jsonHeaders)
        }
        return FmaApi("https://mail.example.org", { token }, onUnauthorized, engine)
    }

    private fun bodyOf(request: HttpRequestData): String = (request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString()

    @Test
    fun loginSendsNativeClientWithoutAuthHeaderAndReturnsToken() = runTest {
        val api = api(token = null) { HttpStatusCode.OK to """{"email":"me@example.org","token":"abc"}""" }
        val result = api.login("me@example.org", "secret-password", "Pixel", "android")
        assertEquals("abc", result.token)
        val request = requests.single()
        assertEquals("https://mail.example.org/api/auth/login", request.url.toString())
        assertNull(request.headers[HttpHeaders.Authorization])
        val body = Json.parseToJsonElement(bodyOf(request)).jsonObject
        assertEquals("native", body["client"]!!.jsonPrimitive.content)
        assertEquals("android", body["platform"]!!.jsonPrimitive.content)
    }

    @Test
    fun authenticatedCallsUseBearerAndIgnoreUnknownFields() = runTest {
        val api = api {
            HttpStatusCode.OK to """{"accounts":[{"id":"a1","displayName":"Work","emailAddress":"w@example.org",
                "imap":{"host":"imap","port":993},"smtp":{"host":"smtp","port":465},"status":"ok","lastErrorCode":null,
                "nextRetryAt":null,"capabilities":[],"sortOrder":0,"lastSyncAt":null,"syncSince":null,"unreadCount":3,
                "syncing":false,"futureField":1}]}"""
        }
        val accounts = api.accounts()
        assertEquals(3, accounts.single().unreadCount)
        assertEquals("Bearer tok", requests.single().headers[HttpHeaders.Authorization])
    }

    @Test
    fun unauthorizedTriggersLogoutCallback() = runTest {
        var loggedOut = false
        val api = api(onUnauthorized = { loggedOut = true }) { HttpStatusCode.Unauthorized to """{"message":"Not authenticated"}""" }
        val error = assertFailsWith<ApiException> { api.accounts() }
        assertTrue(error.isUnauthorized)
        assertEquals("Not authenticated", error.message)
        assertTrue(loggedOut)
    }

    @Test
    fun messagePageAndActions() = runTest {
        val api = api { request ->
            when {
                request.method == HttpMethod.Get -> HttpStatusCode.OK to """{"messages":[{"id":"m1","subject":"Hi",
                    "from":{"name":"","address":"a@example.org"},"date":"2026-10-09T10:00:00.000Z","snippet":"",
                    "flags":{"seen":false,"flagged":false,"answered":false},"hasAttachments":false,"threadId":null,
                    "threadCount":1}],"nextCursor":"c2"}"""
                else -> HttpStatusCode.OK to """{"updated":1}"""
            }
        }
        val page = api.messages("f1", cursor = "c1")
        assertEquals("c2", page.nextCursor)
        assertEquals("a@example.org", page.messages.single().from!!.label)
        assertEquals("c1", requests[0].url.parameters["cursor"])
        assertEquals(1, api.messageAction("f1", listOf("m1"), "read"))
        val body = Json.parseToJsonElement(bodyOf(requests[1])).jsonObject
        assertEquals("read", body["action"]!!.jsonPrimitive.content)
        assertTrue("targetFolderId" !in body, "null fields are omitted")
    }

    @Test
    fun htmlBlocksRemoteContentByDefault() = runTest {
        val api = api { HttpStatusCode.OK to """{"html":"<p>x</p>","remoteContentBlocked":true}""" }
        val html = api.messageHtml("m1")
        assertEquals("0", requests.single().url.parameters["remote"])
        assertTrue(html.remoteContentBlocked)
    }

    @Test
    fun fcmRegistrationBody() = runTest {
        val api = api { HttpStatusCode.Created to """{"id":"s1"}""" }
        api.registerFcm("fcm-token-123456789012345")
        val body = Json.parseToJsonElement(bodyOf(requests.single())).jsonObject
        assertEquals("fcm", body["transport"]!!.jsonPrimitive.content)
        assertEquals("fcm-token-123456789012345", body["token"]!!.jsonPrimitive.content)
    }
}
