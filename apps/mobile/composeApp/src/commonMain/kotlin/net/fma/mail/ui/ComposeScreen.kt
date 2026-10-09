package net.fma.mail.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import net.fma.mail.api.ComposeIdentity
import net.fma.mail.api.SendMessageRequest
import net.fma.mail.domain.isPlausibleAddress
import net.fma.mail.domain.parseRecipients
import net.fma.mail.domain.forward
import net.fma.mail.domain.replyAll
import net.fma.mail.domain.replyTo
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * New message or reply (#150), plain text without attachments: identity
 * choice, to/cc, subject, text; sent through the outbox. No drafts yet.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalUuidApi::class)
@Composable
fun ComposeScreen(vm: AppViewModel, mode: String, messageId: String?, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val accountId = remember { vm.mail.value.selectedAccountId }
    var identities by remember { mutableStateOf<List<ComposeIdentity>>(emptyList()) }
    var identity by remember { mutableStateOf<ComposeIdentity?>(null) }
    var to by remember { mutableStateOf("") }
    var cc by remember { mutableStateOf("") }
    var subject by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    var inReplyTo by remember { mutableStateOf<String?>(null) }
    var references by remember { mutableStateOf<List<String>?>(null) }
    var sending by remember { mutableStateOf(false) }
    // Navigation happens in composition (main thread), not from the send coroutine.
    var sent by remember { mutableStateOf(false) }
    LaunchedEffect(sent) { if (sent) onClose() }
    var error by remember { mutableStateOf<String?>(null) }
    // Idempotency key: a retry after a network error does not send twice.
    val clientId = remember { Uuid.random().toString() }

    LaunchedEffect(accountId, messageId) {
        val api = vm.api ?: return@LaunchedEffect
        if (accountId == null) return@LaunchedEffect
        try {
            identities = api.identities(accountId)
            identity = identities.firstOrNull { it.isDefault } ?: identities.firstOrNull()
            if (messageId != null && mode != "new") {
                val original = api.message(messageId)
                val own = identities.map { it.emailAddress } + listOfNotNull(vm.mail.value.selectedAccount?.emailAddress)
                val draft = when (mode) {
                    "forward" -> forward(original)
                    "replyAll" -> replyAll(original, own).also { cc = it.second }.first
                    else -> replyTo(original)
                }
                to = draft.to
                subject = draft.subject
                body = draft.body
                inReplyTo = draft.inReplyTo
                references = draft.references
            }
            identity?.signature?.takeIf { it.isNotBlank() }?.let { signature ->
                if (!body.contains(signature)) body = "\n\n-- \n$signature$body"
            }
        } catch (e: Exception) {
            error = AppViewModel.errorText(e)
        }
    }

    fun send() {
        val api = vm.api ?: return
        val account = accountId ?: return
        val toList = parseRecipients(to)
        val ccList = parseRecipients(cc)
        val invalid = (toList + ccList).filterNot(::isPlausibleAddress)
        error = when {
            toList.isEmpty() && ccList.isEmpty() -> "Mindestens ein Empfänger ist nötig."
            invalid.isNotEmpty() -> "Ungültige Adresse: ${invalid.first()}"
            else -> null
        }
        if (error != null) return
        sending = true
        scope.launch {
            sent = try {
                api.send(
                    SendMessageRequest(
                        accountId = account,
                        identityId = identity?.id,
                        to = toList,
                        cc = ccList,
                        subject = subject,
                        text = body,
                        inReplyTo = inReplyTo,
                        references = references,
                        clientId = clientId,
                    ),
                )
                true
            } catch (e: Exception) {
                error = AppViewModel.errorText(e)
                false
            } finally {
                sending = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        when (mode) {
                            "reply" -> "Antworten"
                            "replyAll" -> "Allen antworten"
                            "forward" -> "Weiterleiten"
                            else -> "Neue E-Mail"
                        },
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Verwerfen") }
                },
                actions = {
                    if (sending) {
                        CircularProgressIndicator(Modifier.padding(12.dp))
                    } else {
                        IconButton(onClick = ::send, enabled = identity != null) {
                            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Senden")
                        }
                    }
                },
            )
        },
    ) { padding ->
        if (accountId == null) {
            Box(Modifier.fillMaxSize().padding(padding), Alignment.Center) { Text("Kein Konto ausgewählt.") }
            return@Scaffold
        }
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            IdentityPicker(identities, identity) { identity = it }
            OutlinedTextField(
                to, { to = it }, label = { Text("An") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                cc, { cc = it }, label = { Text("Cc") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(subject, { subject = it }, label = { Text("Betreff") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(body, { body = it }, label = { Text("Nachricht") }, modifier = Modifier.fillMaxWidth().heightIn(min = 240.dp))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun IdentityPicker(identities: List<ComposeIdentity>, selected: ComposeIdentity?, onSelect: (ComposeIdentity) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selected?.label ?: "",
            onValueChange = {},
            readOnly = true,
            label = { Text("Von") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            identities.forEach { identity ->
                DropdownMenuItem(text = { Text(identity.label) }, onClick = {
                    onSelect(identity)
                    expanded = false
                })
            }
        }
    }
}
