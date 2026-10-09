package net.fma.mail.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.flow.Flow
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

    override fun openExternal(url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme?.lowercase() !in setOf("http", "https", "mailto")) return
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
            // No app for this link.
        }
    }

    /**
     * Locked-down WebView (#149): no JavaScript, no file/content access, no
     * storage, no new windows; without allowRemote no network loads at all
     * (the server already strips remote content unless asked). Every
     * navigation is cancelled and handed to [onLink] (opened externally).
     */
    @SuppressLint("SetJavaScriptEnabled")
    @Composable
    override fun HtmlView(html: String, allowRemote: Boolean, onLink: (String) -> Unit, modifier: Modifier) {
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
                val key = html.hashCode() * 31 + allowRemote.hashCode()
                if (view.tag != key) {
                    view.tag = key
                    view.loadDataWithBaseURL("about:blank", wrap(html), "text/html", "utf-8", null)
                }
            },
        )
    }

    private fun wrap(html: String): String =
        "<!doctype html><html><head><meta charset=\"utf-8\">" +
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
            "<style>body{margin:12px;font-family:sans-serif;word-wrap:break-word}img{max-width:100%;height:auto}</style>" +
            "</head><body>$html</body></html>"
}
