package net.fma.mail.api

import kotlinx.serialization.Serializable

// DTOs of docs/api/openapi.yaml (the only source of the API contract,
// ADR-0010). Unknown JSON keys are ignored, so additive server changes
// do not break the app. TODO(#143): replace with models generated from
// the spec once the generator handles OpenAPI 3.1 nullables cleanly.

@Serializable
data class HealthStatus(val status: String, val service: String = "", val version: String = "")

@Serializable
data class AuthStatus(val needsSetup: Boolean, val authenticated: Boolean, val email: String? = null)

@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
    val deviceName: String,
    val platform: String,
    val client: String = "native",
)

@Serializable
data class LoginResponse(val email: String, val token: String? = null)

@Serializable
data class DeviceInfo(
    val id: String,
    val name: String,
    val platform: String,
    val lastSeenAt: String? = null,
    val isCurrent: Boolean,
)

@Serializable
data class DeviceListResponse(val devices: List<DeviceInfo>)

@Serializable
data class HostPort(val host: String, val port: Int)

@Serializable
data class AccountSummary(
    val id: String,
    val displayName: String,
    val emailAddress: String,
    val status: String,
    val lastErrorCode: String? = null,
    val nextRetryAt: String? = null,
    val sortOrder: Int = 0,
    val lastSyncAt: String? = null,
    val unreadCount: Int = 0,
    val syncing: Boolean = false,
) {
    val hasError: Boolean get() = status != "ok"
}

@Serializable
data class AccountListResponse(val accounts: List<AccountSummary>)

@Serializable
data class SyncRequestResult(val accountId: String, val queued: Boolean, val reason: String? = null)

@Serializable
data class SyncResponse(val accounts: List<SyncRequestResult>)

@Serializable
data class AccountSyncStatus(
    val accountId: String,
    val state: String,
    val phase: String? = null,
    val done: Int? = null,
    val total: Int? = null,
    val lastSyncAt: String? = null,
    val lastErrorCode: String? = null,
)

@Serializable
data class SyncStatusResponse(val accounts: List<AccountSyncStatus>)

@Serializable
data class FolderSummary(
    val id: String,
    val name: String,
    val path: String,
    val parentId: String? = null,
    val depth: Int = 0,
    val specialUse: String? = null,
    val selectable: Boolean = true,
    val unreadCount: Int = 0,
    val total: Int = 0,
)

@Serializable
data class FolderListResponse(val folders: List<FolderSummary>)

@Serializable
data class MailPerson(val name: String = "", val address: String) {
    val label: String get() = name.ifBlank { address }
}

@Serializable
data class MessageFlags(val seen: Boolean, val flagged: Boolean, val answered: Boolean = false)

@Serializable
data class MessageListItem(
    val id: String,
    val subject: String,
    val from: MailPerson? = null,
    val date: String,
    val snippet: String = "",
    val flags: MessageFlags,
    val hasAttachments: Boolean = false,
    val threadId: String? = null,
    val threadCount: Int = 1,
)

@Serializable
data class MessagePage(val messages: List<MessageListItem>, val nextCursor: String? = null)

@Serializable
data class LoadOlderResponse(val queued: Boolean)

@Serializable
data class MessageDetail(
    val id: String,
    val accountId: String,
    val folderIds: List<String> = emptyList(),
    val subject: String,
    val from: MailPerson? = null,
    val to: List<MailPerson> = emptyList(),
    val cc: List<MailPerson> = emptyList(),
    val replyTo: List<MailPerson> = emptyList(),
    val date: String,
    val flags: MessageFlags,
    val hasAttachments: Boolean = false,
    val messageId: String? = null,
    val references: List<String> = emptyList(),
    val text: String? = null,
    val threadId: String? = null,
)

@Serializable
data class MessageHtml(val html: String? = null, val remoteContentBlocked: Boolean = false)

@Serializable
data class MessageActionRequest(
    val folderId: String,
    val messageIds: List<String>,
    val action: String,
    val targetFolderId: String? = null,
)

@Serializable
data class MessageActionResponse(val updated: Int)

@Serializable
data class ComposeIdentity(
    val id: String,
    val name: String = "",
    val emailAddress: String,
    val signature: String? = null,
    val isDefault: Boolean = false,
) {
    val label: String get() = if (name.isBlank()) emailAddress else "$name <$emailAddress>"
}

@Serializable
data class IdentityListResponse(val identities: List<ComposeIdentity>)

@Serializable
data class SendMessageRequest(
    val accountId: String,
    val identityId: String? = null,
    val to: List<String> = emptyList(),
    val cc: List<String> = emptyList(),
    val subject: String,
    val text: String,
    val inReplyTo: String? = null,
    val references: List<String>? = null,
    val clientId: String,
)

@Serializable
data class OutboxError(val code: String, val message: String)

@Serializable
data class OutboxMessage(
    val id: String,
    val accountId: String,
    val status: String,
    val error: OutboxError? = null,
)

@Serializable
data class FcmSubscriptionRequest(val token: String, val transport: String = "fcm")

@Serializable
data class PushUnsubscribeRequest(val endpoint: String)

@Serializable
data class ErrorMessage(val message: String = "")
