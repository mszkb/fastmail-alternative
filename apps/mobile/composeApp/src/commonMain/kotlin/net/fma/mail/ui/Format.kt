package net.fma.mail.ui

import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlin.time.Clock
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

/** ISO timestamp from the API -> "14:05" (today) or "09.10. 14:05", in the device time zone. */
@OptIn(ExperimentalTime::class)
fun shortDate(iso: String): String {
    val zone = TimeZone.currentSystemDefault()
    val local = runCatching { Instant.parse(iso).toLocalDateTime(zone) }.getOrNull() ?: return iso
    val today = Clock.System.now().toLocalDateTime(zone).date
    val time = "${pad(local.hour)}:${pad(local.minute)}"
    return if (local.date == today) time else "${pad(local.dayOfMonth)}.${pad(local.monthNumber)}. $time"
}

private fun pad(value: Int) = value.toString().padStart(2, '0')

fun initials(name: String): String =
    name.split(' ', '@', '.').filter { it.isNotBlank() }.take(2).joinToString("") { it.first().uppercase() }.ifEmpty { "?" }
