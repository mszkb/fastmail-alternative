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
import androidx.compose.material.icons.filled.Delete
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
import kotlinx.coroutines.delay
import net.fma.mail.api.ApiException
import net.fma.mail.api.ComposeIdentity
import net.fma.mail.api.SaveDraftRequest
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
    // Replies and forwards always go out from the message's own account (also in the unified view).
    var accountId by remember { mutableStateOf(if (messageId == null) vm.mail.value.composeAccountId else null) }
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
    // Server-side draft (#150): client-generated id, version 0 = not saved yet.
    var draftId by remember { mutableStateOf(Uuid.random().toString()) }
    var draftVersion by remember { mutableStateOf(0) }
    var draftStatus by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }

    LaunchedEffect(messageId) {
        val api = vm.api ?: return@LaunchedEffect
        try {
            if (mode == "draft" && messageId != null) {
                // A message of the Drafts folder: continue the server-side draft.
                val draft = api.openDraft(messageId)
                accountId = draft.accountId
                identities = api.identities(draft.accountId)
                identity = identities.firstOrNull { it.id == draft.identityId }
                    ?: identities.firstOrNull { it.isDefault } ?: identities.firstOrNull()
                to = draft.to
                cc = draft.cc
                subject = draft.subject
                body = draft.text
                inReplyTo = draft.inReplyTo
                references = draft.references
                draftId = draft.id
                draftVersion = draft.version
                loaded = true
                return@LaunchedEffect
            }
            val original = if (messageId != null && mode != "new") api.message(messageId) else null
            val account = original?.accountId ?: vm.mail.value.composeAccountId ?: return@LaunchedEffect
            accountId = account
            identities = api.identities(account)
            identity = identities.firstOrNull { it.isDefault } ?: identities.firstOrNull()
            if (original != null) {
                val own = identities.map { it.emailAddress } +
                    listOfNotNull(vm.mail.value.accounts.firstOrNull { it.id == account }?.emailAddress)
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
            loaded = true
        } catch (e: Exception) {
            error = AppViewModel.errorText(e)
        }
    }

    // Autosave 2 s after the last change (like the PWA). A conflict with another
    // device is resolved last-write-wins (force) - this device is being edited now.
    LaunchedEffect(to, cc, subject, body, identity, loaded, sending, sent) {
        val api = vm.api ?: return@LaunchedEffect
        val account = accountId ?: return@LaunchedEffect
        if (!loaded || sending || sent) return@LaunchedEffect
        if (draftVersion == 0 && to.isBlank() && cc.isBlank() && subject.isBlank() && body.isBlank()) return@LaunchedEffect
        delay(2_000)
        if (sending || sent) return@LaunchedEffect
        fun request(force: Boolean) = SaveDraftRequest(
            accountId = account, identityId = identity?.id, to = to, cc = cc, subject = subject, text = body,
            inReplyTo = inReplyTo, references = references.orEmpty(), baseVersion = draftVersion, force = force,
        )
        draftStatus = try {
            draftVersion = try {
                api.saveDraft(draftId, request(force = false)).version
            } catch (e: ApiException) {
                if (e.status != 409) throw e
                api.saveDraft(draftId, request(force = true)).version
            }
            "Entwurf gespeichert"
        } catch (e: ApiException) {
            if (e.status == 410) "Entwurf wurde bereits gesendet oder verworfen" else "Entwurf nicht gespeichert"
        } catch (e: Exception) {
            "Entwurf nicht gespeichert (offline?)"
        }
    }

    fun discard() {
        val api = vm.api
        if (api != null && draftVersion > 0) {
            val id = draftId
            vm.launchQuietly { api.deleteDraft(id) }
        }
        sent = true // leaves the screen through the same LaunchedEffect
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
                        draftId = draftId.takeIf { draftVersion > 0 },
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
                            "draft" -> "Entwurf"
                            else -> "Neue E-Mail"
                        },
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zurück, Entwurf behalten")
                    }
                },
                actions = {
                    IconButton(onClick = ::discard, enabled = !sending) {
                        Icon(Icons.Filled.Delete, contentDescription = "Verwerfen")
                    }
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
            Box(Modifier.fillMaxSize().padding(padding), Alignment.Center) {
                if (messageId != null && error == null) CircularProgressIndicator() else Text(error ?: "Kein Konto ausgewählt.")
            }
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
            draftStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
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
