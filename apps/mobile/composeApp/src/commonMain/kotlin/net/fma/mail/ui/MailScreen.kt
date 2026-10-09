package net.fma.mail.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Badge
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import net.fma.mail.api.AccountSummary
import net.fma.mail.api.FolderSummary
import net.fma.mail.api.MessageListItem
import net.fma.mail.domain.folderRoleLabel

/** Account switcher, folders and message list (#147, #148). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MailScreen(
    vm: AppViewModel,
    onOpenMessage: (messageId: String, folderId: String) -> Unit,
    onCompose: () -> Unit,
    onSearch: () -> Unit,
    onSettings: () -> Unit,
) {
    val state by vm.mail.collectAsState()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(state.error, state.notice) {
        (state.error ?: state.notice)?.let {
            snackbar.showSnackbar(it)
            vm.clearError()
        }
    }

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet {
                Text(
                    state.selectedAccount?.displayName ?: "Ordner",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(16.dp),
                )
                LazyColumn {
                    items(state.folders, key = { it.id }) { folder ->
                        FolderRow(folder, folder.id == state.selectedFolderId) {
                            vm.selectFolder(folder.id)
                            scope.launch { drawer.close() }
                        }
                    }
                }
            }
        },
    ) {
        Scaffold(
            topBar = {
                Column {
                    TopAppBar(
                        title = { Text(state.selectedFolder?.let { folderTitle(it) } ?: "E-Mail") },
                        navigationIcon = {
                            IconButton(onClick = { scope.launch { drawer.open() } }) {
                                Icon(Icons.Filled.Menu, contentDescription = "Ordner")
                            }
                        },
                        actions = {
                            if (state.selectedAccountId != null) {
                                IconButton(onClick = onSearch) { Icon(Icons.Filled.Search, contentDescription = "Suchen") }
                            }
                            IconButton(onClick = onSettings) { Icon(Icons.Filled.Settings, contentDescription = "Einstellungen") }
                        },
                    )
                    AccountBar(state.accounts, state.selectedAccountId, vm::selectAccount)
                }
            },
            floatingActionButton = {
                if (state.selectedAccountId != null) {
                    FloatingActionButton(onClick = onCompose) { Icon(Icons.Filled.Edit, contentDescription = "Verfassen") }
                }
            },
            snackbarHost = { SnackbarHost(snackbar) },
        ) { padding ->
            PullToRefreshBox(
                isRefreshing = state.refreshing,
                onRefresh = vm::refresh,
                modifier = Modifier.fillMaxSize().padding(padding),
            ) {
                val account = state.selectedAccount
                when {
                    state.accounts.isEmpty() && !state.loadingMessages -> EmptyHint(
                        "Noch keine Konten. Konten richtest du in der Web-App ein.",
                    )
                    state.loadingMessages && state.messages.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                        CircularProgressIndicator()
                    }
                    else -> MessageList(
                        account = account,
                        messages = state.messages,
                        hasMore = state.nextCursor != null,
                        loadingMore = state.loadingMore,
                        onLoadMore = vm::loadMore,
                        onLoadOlder = vm::loadOlder,
                        onOpen = { id -> state.selectedFolderId?.let { onOpenMessage(id, it) } },
                    )
                }
            }
        }
    }
}

private fun folderTitle(folder: FolderSummary) = folderRoleLabel(folder.specialUse) ?: folder.name

@Composable
private fun FolderRow(folder: FolderSummary, selected: Boolean, onClick: () -> Unit) {
    NavigationDrawerItem(
        label = { Text(folderTitle(folder), modifier = Modifier.padding(start = (folder.depth * 12).dp)) },
        badge = { if (folder.unreadCount > 0) Text(folder.unreadCount.toString()) },
        selected = selected,
        onClick = { if (folder.selectable) onClick() },
        modifier = Modifier.padding(horizontal = 12.dp),
    )
}

/** One account at a time (principle 8): chips with unread badge and error dot. */
@Composable
private fun AccountBar(accounts: List<AccountSummary>, selectedId: String?, onSelect: (String) -> Unit) {
    if (accounts.size <= 1 && accounts.firstOrNull()?.hasError != true) return
    LazyRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        items(accounts, key = { it.id }) { account ->
            FilterChip(
                selected = account.id == selectedId,
                onClick = { onSelect(account.id) },
                label = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (account.hasError) {
                            Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.error, CircleShape))
                            Spacer(Modifier.width(6.dp))
                        }
                        Text(account.displayName.ifBlank { account.emailAddress }, maxLines = 1)
                        if (account.unreadCount > 0) {
                            Spacer(Modifier.width(6.dp))
                            Badge { Text(if (account.unreadCount > 999) "999+" else account.unreadCount.toString()) }
                        }
                    }
                },
            )
        }
    }
}

@Composable
private fun MessageList(
    account: AccountSummary?,
    messages: List<MessageListItem>,
    hasMore: Boolean,
    loadingMore: Boolean,
    onLoadMore: () -> Unit,
    onLoadOlder: () -> Unit,
    onOpen: (String) -> Unit,
) {
    val listState = rememberLazyListState()
    val nearEnd by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= listState.layoutInfo.totalItemsCount - 5
        }
    }
    LaunchedEffect(nearEnd, hasMore, messages.size) {
        if (nearEnd && hasMore) onLoadMore()
    }
    LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
        if (account?.hasError == true) {
            item(key = "account-error") { AccountErrorBanner(account) }
        }
        if (messages.isEmpty()) {
            item(key = "empty") { EmptyHint(if (account?.syncing == true) "Wird synchronisiert …" else "Keine Nachrichten in diesem Ordner.") }
        }
        items(messages, key = { it.id }) { message ->
            MessageRow(message) { onOpen(message.id) }
            HorizontalDivider()
        }
        if (loadingMore) {
            item(key = "more") {
                Box(Modifier.fillMaxWidth().padding(16.dp), Alignment.Center) { CircularProgressIndicator() }
            }
        } else if (!hasMore && messages.isNotEmpty()) {
            item(key = "older") {
                Box(Modifier.fillMaxWidth().padding(8.dp), Alignment.Center) {
                    TextButton(onClick = onLoadOlder) { Text("Ältere Nachrichten vom Server laden") }
                }
            }
        }
    }
}

@Composable
private fun AccountErrorBanner(account: AccountSummary) {
    val text = when (account.status) {
        "auth_error" -> "Anmeldung beim Mailanbieter fehlgeschlagen. Zugangsdaten in der Web-App prüfen."
        "unreachable" -> "Mailserver nicht erreichbar, neuer Versuch läuft automatisch."
        "disabled" -> "Konto ist deaktiviert."
        else -> "Konto meldet einen Fehler."
    }
    Text(
        text,
        color = MaterialTheme.colorScheme.onErrorContainer,
        modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer).padding(12.dp),
    )
}

@Composable
internal fun MessageRow(message: MessageListItem, onClick: () -> Unit) {
    val unread = !message.flags.seen
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (unread) {
                Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
                Spacer(Modifier.width(6.dp))
            }
            Text(
                message.from?.label ?: "(kein Absender)",
                fontWeight = if (unread) FontWeight.Bold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (message.flags.flagged) {
                Icon(Icons.Filled.Star, contentDescription = "Markiert", tint = Color(0xFFF59E0B), modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
            }
            Text(shortDate(message.date), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
        }
        Text(
            message.subject.ifBlank { "(kein Betreff)" } + if (message.threadCount > 1) "  (${message.threadCount})" else "",
            fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (message.snippet.isNotBlank()) {
            Text(
                message.snippet,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.secondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
fun EmptyHint(text: String) {
    Box(Modifier.fillMaxWidth().padding(32.dp), Alignment.Center) {
        Text(text, color = MaterialTheme.colorScheme.secondary)
    }
}
