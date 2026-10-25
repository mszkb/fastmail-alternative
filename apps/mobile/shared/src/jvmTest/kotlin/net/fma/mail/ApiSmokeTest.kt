package net.fma.mail

import kotlinx.coroutines.runBlocking
import net.fma.mail.api.ApiException
import net.fma.mail.api.FmaApi
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Runs the Kotlin client against a real PHP API (#143) when FMA_API_URL is
 * set (CI job mobile-android, or locally against `pnpm dev:api`); skipped
 * otherwise. Needs SETUP_TOKEN of the server for a fresh database.
 */
class ApiSmokeTest {
    private val url = System.getenv("FMA_API_URL").orEmpty()
    private val email = System.getenv("FMA_EMAIL") ?: "contract@example.org"
    private val password = System.getenv("FMA_PASSWORD") ?: "contract-password-1"

    @Test
    fun loginReadAndLogoutWithDeviceToken() = runBlocking {
        if (url.isEmpty()) return@runBlocking
        val anonymous = FmaApi(url, { null })
        assertEquals("ok", anonymous.health().status)
        if (anonymous.authStatus().needsSetup) {
            anonymous.setup(email, password, System.getenv("SETUP_TOKEN") ?: "e2e-setup-code")
        }
        val login = anonymous.login(email, password, "Kotlin smoke test", "android")
        val token = assertNotNull(login.token)

        var unauthorized = false
        val api = FmaApi(url, { token }, { unauthorized = true })
        assertTrue(api.authStatus().authenticated)
        val device = api.devices().single { it.isCurrent }
        assertEquals("android", device.platform)
        api.accounts().forEach { account -> api.folders(account.id) }
        api.syncAll()
        api.syncStatus()

        // Without FCM on the server the registration is refused with 422.
        try {
            api.registerFcm("smoke-test-token-1234567890")
        } catch (e: ApiException) {
            assertEquals(422, e.status)
        }

        // No subscription yet: nothing to queue.
        assertEquals(false, api.testPush())

        api.logout()
        try {
            api.accounts()
            fail("token still valid after logout")
        } catch (e: ApiException) {
            assertEquals(401, e.status)
        }
        assertTrue(unauthorized)
        api.close()
        anonymous.close()
    }
}
