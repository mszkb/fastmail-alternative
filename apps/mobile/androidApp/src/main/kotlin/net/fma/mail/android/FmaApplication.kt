package net.fma.mail.android

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.channels.BufferOverflow

class FmaApplication : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Notification tapped or push while the app is visible: show the inbox and sync. */
    val openInbox = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    val push by lazy { AndroidPush(this) }

    @Volatile var isInForeground = false
        private set

    override fun onCreate() {
        super.onCreate()
        Notifications.createChannel(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                isInForeground = true
            }

            override fun onStop(owner: LifecycleOwner) {
                isInForeground = false
            }
        })
    }
}
