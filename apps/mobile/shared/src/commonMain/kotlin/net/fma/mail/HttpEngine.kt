package net.fma.mail

import io.ktor.client.engine.HttpClientEngineFactory

/** Platform HTTP engine (OkHttp on Android/JVM, Darwin on iOS). */
expect fun httpEngine(): HttpClientEngineFactory<*>
