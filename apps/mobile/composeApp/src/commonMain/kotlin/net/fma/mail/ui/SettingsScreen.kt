package net.fma.mail.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import net.fma.mail.api.DeviceInfo

/** Instance, push status, devices (read-only) and logout (#146). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: AppViewModel, platform: Platform, onBack: () -> Unit) {
    val session by vm.session.collectAsState()
    var devices by remember { mutableStateOf<List<DeviceInfo>>(emptyList()) }
    LaunchedEffect(Unit) {
        devices = runCatching { vm.api?.devices() }.getOrNull().orEmpty()
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Einstellungen") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zurück") }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Instanz", style = MaterialTheme.typography.titleMedium)
            Text(session?.baseUrl.orEmpty())
            Text("Angemeldet als ${session?.email.orEmpty()}", color = MaterialTheme.colorScheme.secondary)
            HorizontalDivider()
            Text("Benachrichtigungen", style = MaterialTheme.typography.titleMedium)
            Text(platform.push.status())
            HorizontalDivider()
            Text("Geräte", style = MaterialTheme.typography.titleMedium)
            devices.forEach { device ->
                Text(
                    device.name + " (" + device.platform + ")" + if (device.isCurrent) " – dieses Gerät" else "",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            Text(
                "Geräte abmelden kannst du in der Web-App.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.secondary,
            )
            HorizontalDivider()
            Button(onClick = vm::logout) { Text("Abmelden") }
        }
    }
}
