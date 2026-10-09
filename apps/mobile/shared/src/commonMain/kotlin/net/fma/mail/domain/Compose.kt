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

/**
 * Reply to all: the sender (or Reply-To) in To, the other recipients in Cc,
 * without the user's own addresses ([ownAddresses], case-insensitive).
 */
fun replyAll(message: MessageDetail, ownAddresses: Collection<String>): Pair<ReplyDraft, String> {
    val draft = replyTo(message)
    val own = ownAddresses.map { it.lowercase() }.toSet()
    val primary = draft.to.lowercase()
    val cc = (message.to + message.cc).map { it.address }
        .filter { it.lowercase() !in own && it.lowercase() != primary }
        .distinctBy { it.lowercase() }
    return draft to cc.joinToString(", ")
}

fun forwardSubject(subject: String): String =
    if (subject.trimStart().startsWith("fwd:", ignoreCase = true) || subject.trimStart().startsWith("wg:", ignoreCase = true)) {
        subject.trim()
    } else {
        "Fwd: ${subject.trim()}"
    }

/** Forward as plain text with a header block (attachments are not forwarded yet, #150). */
fun forward(message: MessageDetail): ReplyDraft {
    val header = buildString {
        append("\n\n---------- Weitergeleitete Nachricht ----------\n")
        append("Von: ${message.from?.let { if (it.name.isBlank()) it.address else "${it.name} <${it.address}>" } ?: "Unbekannt"}\n")
        append("Datum: ${message.date}\n")
        append("Betreff: ${message.subject}\n")
        if (message.to.isNotEmpty()) append("An: ${message.to.joinToString { it.address }}\n")
        append("\n")
    }
    return ReplyDraft(to = "", subject = forwardSubject(message.subject), body = header + message.text.orEmpty(), inReplyTo = null, references = emptyList())
}

/** Comma/semicolon separated addresses; blank entries dropped. */
fun parseRecipients(input: String): List<String> =
    input.split(',', ';', '\n').map { it.trim() }.filter { it.isNotEmpty() }

private val SIMPLE_EMAIL = Regex("^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$")

fun isPlausibleAddress(address: String): Boolean = SIMPLE_EMAIL.matches(address)
