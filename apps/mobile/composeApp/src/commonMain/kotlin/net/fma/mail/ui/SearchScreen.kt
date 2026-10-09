package net.fma.mail.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import net.fma.mail.api.SearchResponse

/**
 * Search in the active account (#152): IMAP SEARCH at the provider over
 * INBOX and the other folders except junk/trash. Accounts stay separate,
 * there is no global search here.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(vm: AppViewModel, onBack: () -> Unit, onOpenMessage: (messageId: String, folderId: String) -> Unit) {
    val scope = rememberCoroutineScope()
    val account = remember { vm.mail.value.selectedAccount }
    var query by remember { mutableStateOf("") }
    var result by remember { mutableStateOf<SearchResponse?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun search() {
        val api = vm.api ?: return
        val accountId = account?.id ?: return
        if (query.isBlank() || busy) return
        busy = true
        error = null
        scope.launch {
            try {
                result = api.search(accountId, query)
            } catch (e: Exception) {
                error = AppViewModel.errorText(e)
            } finally {
                busy = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    TextField(
                        value = query,
                        onValueChange = { query = it },
                        placeholder = { Text("Suchen in ${account?.displayName.orEmpty()}") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        keyboardActions = KeyboardActions(onSearch = { search() }),
                        modifier = Modifier.fillMaxWidth(),
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zurück") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when {
                busy -> Box(Modifier.fillMaxWidth().padding(24.dp), Alignment.Center) { CircularProgressIndicator() }
                error != null -> EmptyHint(error.orEmpty())
                result == null -> EmptyHint("Suchbegriff eingeben und mit der Tastatur suchen. Gesucht wird beim Mailanbieter.")
                result?.messages.isNullOrEmpty() -> EmptyHint("Keine Treffer.")
            }
            val hits = result?.messages.orEmpty()
            if (!busy && hits.isNotEmpty()) {
                if (result?.truncated == true || (result?.notSynced ?: 0) > 0) {
                    Text(
                        "Nicht alle Treffer werden angezeigt (zu viele oder noch nicht synchronisiert).",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                LazyColumn(Modifier.fillMaxSize()) {
                    items(hits, key = { it.id }) { hit ->
                        MessageRow(hit.toListItem()) { onOpenMessage(hit.id, hit.folderId) }
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}
