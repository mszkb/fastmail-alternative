package net.fma.mail.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.flow.Flow
import net.fma.mail.api.AttachmentInfo
import net.fma.mail.domain.SessionStore
import net.fma.mail.ui.Platform
import net.fma.mail.ui.PushController

class AndroidPlatform(private val context: Context, private val app: FmaApplication) : Platform {
    override val sessionStore: SessionStore = SecureSessionStore.get(context)

    override val deviceName: String = listOf(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL)
        .distinct().joinToString(" ").take(100)

    override val platformName: String = "android"

    override val push: PushController get() = app.push

    override val openInboxRequests: Flow<Unit> get() = app.openInbox

    override val syncRequests: Flow<Unit> get() = app.syncNow

    override fun openExternal(url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme?.lowercase() !in setOf("http", "https", "mailto")) return
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
            // No app for this link.
        }
    }

    override fun openAttachment(messageId: String, attachment: AttachmentInfo) {
        val uri = AttachmentProvider.uri(messageId, attachment.index, attachment.contentType, attachment.filename)
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, attachment.contentType)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            // No chooser: the read grant must go to the viewer itself.
            context.startActivity(view)
        } catch (_: Exception) {
            // No app can open this type.
        }
    }

    @Composable
    override fun HtmlView(html: String, allowRemote: Boolean, onLink: (String) -> Unit, modifier: Modifier) =
        LockedWebView(html, allowRemote, onLink, modifier)
}

/**
 * Locked-down WebView (#149): no JavaScript, no file/content access, no
 * storage, no new windows; without allowRemote no network loads at all
 * (the server already strips remote content unless asked). Every
 * navigation is cancelled and handed to [onLink] (opened externally).
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun LockedWebView(html: String, allowRemote: Boolean, onLink: (String) -> Unit, modifier: Modifier) {
    val dark = (LocalConfiguration.current.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView(ctx).apply {
                setBackgroundColor(Color.WHITE)
                settings.apply {
                    javaScriptEnabled = false
                    javaScriptCanOpenWindowsAutomatically = false
                    allowFileAccess = false
                    allowContentAccess = false
                    domStorageEnabled = false
                    databaseEnabled = false
                    setSupportMultipleWindows(false)
                    setGeolocationEnabled(false)
                    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    cacheMode = WebSettings.LOAD_NO_CACHE
                    loadWithOverviewMode = true
                    useWideViewPort = true
                    builtInZoomControls = true
                    displayZoomControls = false
                }
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        onLink(request.url.toString())
                        return true
                    }
                }
            }
        },
        update = { view ->
            view.settings.blockNetworkLoads = !allowRemote
            view.settings.blockNetworkImage = !allowRemote
            val key = (html.hashCode() * 31 + allowRemote.hashCode()) * 31 + dark.hashCode()
            if (view.tag != key) {
                view.tag = key
                view.setBackgroundColor(if (dark) Color.BLACK else Color.WHITE)
                view.loadDataWithBaseURL("about:blank", wrap(html, dark), "text/html", "utf-8", null)
            }
        },
    )
}

// Dark mode: invert the whole mail and invert images back, so designed
// mails stay readable without touching their markup.
private const val DARK_CSS =
    "html{filter:invert(1) hue-rotate(180deg);background:#fff}" +
        "img,video,picture,svg,[style*=background-image]{filter:invert(1) hue-rotate(180deg)}"

private fun wrap(html: String, dark: Boolean): String =
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
        "<style>body{margin:12px;font-family:sans-serif;word-wrap:break-word}img{max-width:100%;height:auto}" +
        (if (dark) DARK_CSS else "") +
        "</style></head><body>$html</body></html>"
