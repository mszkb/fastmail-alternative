package net.fma.mail.ui

/** "2026-10-09T10:00:00.000Z" -> "09.10. 10:00" (UTC; good enough for the preview). */
fun shortDate(iso: String): String {
    if (iso.length < 16) return iso
    val day = iso.substring(8, 10)
    val month = iso.substring(5, 7)
    val time = iso.substring(11, 16)
    return "$day.$month. $time"
}

fun initials(name: String): String =
    name.split(' ', '@', '.').filter { it.isNotBlank() }.take(2).joinToString("") { it.first().uppercase() }.ifEmpty { "?" }
