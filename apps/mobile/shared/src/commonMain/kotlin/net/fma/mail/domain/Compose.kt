package net.fma.mail.domain

import net.fma.mail.api.MessageDetail

/** Reply prefill (subset of the PWA's compose module, #150). */
data class ReplyDraft(
    val to: String,
    val subject: String,
    val body: String,
    val inReplyTo: String?,
    val references: List<String>,
)

fun replySubject(subject: String): String =
    if (subject.trimStart().startsWith("re:", ignoreCase = true)) subject.trim() else "Re: ${subject.trim()}"

fun replyTo(message: MessageDetail): ReplyDraft {
    val recipient = (message.replyTo.firstOrNull() ?: message.from)?.address.orEmpty()
    val quoted = message.text.orEmpty().lines().joinToString("\n") { "> $it" }
    val sender = message.from?.label ?: "Unbekannt"
    val references = (message.references + listOfNotNull(message.messageId)).takeLast(100)
    return ReplyDraft(
        to = recipient,
        subject = replySubject(message.subject),
        body = "\n\n$sender schrieb:\n$quoted",
        inReplyTo = message.messageId,
        references = references,
    )
}

/** Comma/semicolon separated addresses; blank entries dropped. */
fun parseRecipients(input: String): List<String> =
    input.split(',', ';', '\n').map { it.trim() }.filter { it.isNotEmpty() }

private val SIMPLE_EMAIL = Regex("^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$")

fun isPlausibleAddress(address: String): Boolean = SIMPLE_EMAIL.matches(address)
