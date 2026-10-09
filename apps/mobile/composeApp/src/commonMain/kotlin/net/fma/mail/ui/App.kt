package net.fma.mail.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import androidx.navigation.compose.rememberNavController

/**
 * Root: login when there is no session, otherwise mail. Syncs on start and
 * on every return to the foreground (throttled, docs/architecture/push.md);
 * a tapped notification opens the inbox and syncs.
 */
@Composable
fun App(platform: Platform) {
    val vm: AppViewModel = viewModel { AppViewModel(platform) }
    val session by vm.session.collectAsState()
    FmaTheme {
        if (session == null) {
            ConnectScreen(vm)
            return@FmaTheme
        }
        val nav = rememberNavController()
        LifecycleResumeEffect(session) {
            vm.foregroundSync()
            onPauseOrDispose {}
        }
        LaunchedEffect(Unit) {
            platform.openInboxRequests.collect {
                nav.popBackStack("mail", inclusive = false)
                vm.showInbox()
                vm.foregroundSync(force = true)
            }
        }
        NavHost(nav, startDestination = "mail") {
            composable("mail") {
                MailScreen(
                    vm,
                    onOpenMessage = { id, folder -> nav.navigate("message/$id/$folder") },
                    onCompose = { nav.navigate("compose") },
                    onSearch = { nav.navigate("search") },
                    onSettings = { nav.navigate("settings") },
                )
            }
            composable("message/{id}/{folder}") { entry ->
                val id = entry.savedStateHandle.get<String>("id").orEmpty()
                val folder = entry.savedStateHandle.get<String>("folder").orEmpty()
                MessageScreen(
                    vm, platform, id, folder,
                    onBack = { nav.popBackStack() },
                    onCompose = { mode, id -> nav.navigate("compose?mode=$mode&messageId=$id") },
                )
            }
            composable(
                "compose?mode={mode}&messageId={messageId}",
                arguments = listOf("mode", "messageId").map { name ->
                    navArgument(name) {
                        type = NavType.StringType
                        nullable = true
                        defaultValue = null
                    }
                },
            ) { entry ->
                ComposeScreen(
                    vm,
                    mode = entry.savedStateHandle.get<String>("mode") ?: "new",
                    messageId = entry.savedStateHandle.get<String>("messageId"),
                    onClose = { nav.popBackStack() },
                )
            }
            composable("search") {
                SearchScreen(
                    vm,
                    onBack = { nav.popBackStack() },
                    onOpenMessage = { id, folder -> nav.navigate("message/$id/$folder") },
                )
            }
            composable("settings") { SettingsScreen(vm, platform, onBack = { nav.popBackStack() }) }
        }
    }
}
