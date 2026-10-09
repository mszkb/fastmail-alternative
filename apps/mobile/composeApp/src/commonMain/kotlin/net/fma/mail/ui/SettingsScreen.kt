package net.fma.mail.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import net.fma.mail.api.DeviceInfo

/** Instance, push status, devices (read-only) and logout (#146). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: AppViewModel, platform: Platform, onBack: () -> Unit) {
    val session by vm.session.collectAsState()
    var devices by remember { mutableStateOf<List<DeviceInfo>>(emptyList()) }
    var deviceError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
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
            Text("Angemeldet als ${session?.email.orEmpty()}", color = MaterialTheme.colorScheme.onSurfaceVariant)
            HorizontalDivider()
            Text("Benachrichtigungen", style = MaterialTheme.typography.titleMedium)
            Text(platform.push.status())
            var testResult by remember { mutableStateOf<String?>(null) }
            TextButton(onClick = {
                scope.launch {
                    val api = vm.api ?: return@launch
                    testResult = try {
                        if (api.testPush()) {
                            "Test angefordert. Schick die App jetzt in den Hintergrund: Die Benachrichtigung kommt nach dem nächsten Lauf des Servers (meist unter einer Minute)."
                        } else {
                            "Nicht angefordert: kein aktives Push-Abo oder ein Push wartet bereits."
                        }
                    } catch (e: Exception) {
                        AppViewModel.errorText(e)
                    }
                }
            }) { Text("Test-Benachrichtigung senden") }
            testResult?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            HorizontalDivider()
            Text("Geräte", style = MaterialTheme.typography.titleMedium)
            devices.forEach { device ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        device.name + " (" + device.platform + ")" + if (device.isCurrent) " – dieses Gerät" else "",
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f),
                    )
                    if (!device.isCurrent) {
                        TextButton(onClick = {
                            scope.launch {
                                val api = vm.api ?: return@launch
                                deviceError = runCatching { api.revokeDevice(device.id) }.exceptionOrNull()?.let { "Abmelden fehlgeschlagen." }
                                devices = runCatching { api.devices() }.getOrDefault(devices)
                            }
                        }) { Text("Abmelden") }
                    }
                }
            }
            deviceError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            HorizontalDivider()
            Button(onClick = vm::logout) { Text("Abmelden") }
        }
    }
}
