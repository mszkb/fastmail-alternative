package net.fma.mail.android

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import net.fma.mail.ui.App

class MainActivity : ComponentActivity() {
    private var permissionResult: CompletableDeferred<Boolean>? = null

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionResult?.complete(granted)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val app = application as FmaApplication
        app.push.requestPermission = ::requestNotificationPermission
        val platform = AndroidPlatform(applicationContext, app)
        setContent { App(platform) }
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        Notifications.clear(this)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(Notifications.EXTRA_OPEN_INBOX, false) == true) {
            intent.removeExtra(Notifications.EXTRA_OPEN_INBOX)
            (application as FmaApplication).openInbox.tryEmit(Unit)
        }
    }

    /** POST_NOTIFICATIONS (Android 13+), asked once after login. */
    private suspend fun requestNotificationPermission(): Boolean {
        if (Notifications.canNotify(this)) return true
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        val deferred = CompletableDeferred<Boolean>()
        permissionResult = deferred
        runOnUiThread { permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }
        // Activity recreated while the dialog was open: do not wait forever.
        return withTimeoutOrNull(120_000) { deferred.await() } ?: Notifications.canNotify(this)
    }
}
