package net.fma.mail.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import kotlinx.coroutines.flow.Flow
import net.fma.mail.api.FmaApi
import net.fma.mail.domain.SessionStore

/**
 * What the shared UI needs from the platform (Android today, iOS later):
 * secure session storage, the locked-down HTML view, external links and
 * push registration. Implemented in androidApp.
 */
interface Platform {
    val sessionStore: SessionStore

    /** Device name shown in the device list, e.g. "Pixel 8". */
    val deviceName: String

    /** `android` or `ios` (DeviceInfo.platform). */
    val platformName: String

    /** Opens a link outside the app (browser); only http(s) and mailto. */
    fun openExternal(url: String)

    /**
     * Sanitized mail HTML from the server, rendered without JavaScript,
     * file or content access; links go to [onLink]. Without [allowRemote]
     * the view loads nothing from the network at all.
     */
    @Composable
    fun HtmlView(html: String, allowRemote: Boolean, onLink: (String) -> Unit, modifier: Modifier)

    val push: PushController

    /** Emits when a notification was tapped: show the inbox and sync. */
    val openInboxRequests: Flow<Unit>
}

interface PushController {
    /** After login and on every start while logged in: permission, token, registration. */
    suspend fun register(api: FmaApi)

    /** Logout: unregister on the server (best effort) and locally. */
    suspend fun unregister(api: FmaApi)

    /** Human-readable push status for the settings screen. */
    fun status(): String
}
