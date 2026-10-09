package net.fma.mail.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MarkEmailUnread
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import net.fma.mail.api.MessageDetail
import net.fma.mail.api.MessageHtml
import net.fma.mail.domain.folderRoleLabel

/**
 * Read a message (#149): sanitized HTML from the server in the locked-down
 * platform view, remote images blocked until "Bilder laden"; plain text
 * as fallback. Actions (#151): unread, flag, archive, delete, reply.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageScreen(
    vm: AppViewModel,
    platform: Platform,
    messageId: String,
    folderId: String,
    onBack: () -> Unit,
    onCompose: (mode: String, messageId: String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var message by remember { mutableStateOf<MessageDetail?>(null) }
    var html by remember { mutableStateOf<MessageHtml?>(null) }
    var remote by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var flagged by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var moveOpen by remember { mutableStateOf(false) }
    val folders = vm.mail.collectAsState().value.folders

    LaunchedEffect(messageId) {
        val api = vm.api ?: return@LaunchedEffect
        try {
            val detail = api.message(messageId)
            message = detail
            flagged = detail.flags.flagged
            if (!detail.flags.seen) vm.messageAction(messageId, "read", folderId)
        } catch (e: Exception) {
            error = AppViewModel.errorText(e)
        }
    }
    LaunchedEffect(messageId, remote) {
        val api = vm.api ?: return@LaunchedEffect
        html = runCatching { api.messageHtml(messageId, remote) }.getOrNull()
    }

    fun act(action: String, leave: Boolean, target: String? = null) {
        vm.messageAction(messageId, action, folderId, target) { failure ->
            if (failure != null) scope.launch { snackbar.showSnackbar(failure) }
        }
        if (leave) onBack()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zurück") }
                },
                actions = {
                    IconButton(onClick = { act("unread", leave = true) }) {
                        Icon(Icons.Filled.MarkEmailUnread, contentDescription = "Als ungelesen markieren")
                    }
                    IconButton(onClick = {
                        flagged = !flagged
                        act(if (flagged) "flag" else "unflag", leave = false)
                    }) {
                        Icon(if (flagged) Icons.Filled.Star else Icons.Filled.StarBorder, contentDescription = "Markieren")
                    }
                    IconButton(onClick = { act("archive", leave = true) }) {
                        Icon(Icons.Filled.Archive, contentDescription = "Archivieren")
                    }
                    IconButton(onClick = { act("delete", leave = true) }) {
                        Icon(Icons.Filled.Delete, contentDescription = "Löschen")
                    }
                    IconButton(onClick = { onCompose("reply", messageId) }, enabled = message != null) {
                        Icon(Icons.AutoMirrored.Filled.Reply, contentDescription = "Antworten")
                    }
                    Box {
                        IconButton(onClick = { menuOpen = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "Mehr") }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(text = { Text("Allen antworten") }, enabled = message != null, onClick = {
                                menuOpen = false
                                onCompose("replyAll", messageId)
                            })
                            DropdownMenuItem(text = { Text("Weiterleiten") }, enabled = message != null, onClick = {
                                menuOpen = false
                                onCompose("forward", messageId)
                            })
                            DropdownMenuItem(text = { Text("Verschieben …") }, onClick = {
                                menuOpen = false
                                moveOpen = true
                            })
                            val junk = folders.firstOrNull { it.specialUse == "junk" && it.id != folderId }
                            if (junk != null) {
                                DropdownMenuItem(text = { Text("Als Spam markieren") }, onClick = {
                                    menuOpen = false
                                    act("move", leave = true, target = junk.id)
                                })
                            }
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        if (moveOpen) {
            AlertDialog(
                onDismissRequest = { moveOpen = false },
                title = { Text("Verschieben nach") },
                text = {
                    LazyColumn {
                        items(folders.filter { it.selectable && it.id != folderId }, key = { it.id }) { folder ->
                            Text(
                                folderRoleLabel(folder.specialUse) ?: folder.path,
                                modifier = Modifier.fillMaxWidth().clickable {
                                    moveOpen = false
                                    act("move", leave = true, target = folder.id)
                                }.padding(vertical = 12.dp, horizontal = (8 + folder.depth * 12).dp),
                            )
                        }
                    }
                },
                confirmButton = { TextButton(onClick = { moveOpen = false }) { Text("Abbrechen") } },
            )
        }
        val detail = message
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                error != null -> EmptyHint(error.orEmpty())
                detail == null -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
                else -> Column(Modifier.fillMaxSize()) {
                    Header(detail)
                    HorizontalDivider()
                    val body = html
                    if (body?.remoteContentBlocked == true && !remote) {
                        TextButton(onClick = { remote = true }, modifier = Modifier.padding(horizontal = 8.dp)) {
                            Text("Externe Bilder laden")
                        }
                    }
                    val markup = body?.html
                    if (markup != null) {
                        platform.HtmlView(markup, remote, platform::openExternal, Modifier.fillMaxSize())
                    } else if (body == null && detail.text == null) {
                        Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
                    } else {
                        SelectionContainer {
                            Text(
                                detail.text ?: "Der Inhalt wird noch geladen. Bitte später erneut öffnen.",
                                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Header(message: MessageDetail) {
    Column(Modifier.fillMaxWidth().padding(16.dp)) {
        Text(message.subject.ifBlank { "(kein Betreff)" }, style = MaterialTheme.typography.titleLarge)
        val from = message.from
        Text(
            if (from == null) "(kein Absender)" else if (from.name.isBlank()) from.address else "${from.name} <${from.address}>",
            style = MaterialTheme.typography.bodyMedium,
        )
        if (message.to.isNotEmpty()) {
            Text(
                "An: " + message.to.joinToString { it.label },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.secondary,
            )
        }
        Text(shortDate(message.date), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
    }
}
