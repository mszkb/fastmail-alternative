package net.fma.mail.api

/**
 * Normalizes the instance address typed by the user. HTTPS is mandatory
 * (#146): tokens and mail content never travel in clear text.
 */
object InstanceUrl {
    sealed interface Result {
        data class Ok(val baseUrl: String) : Result
        data class Invalid(val reason: String) : Result
    }

    fun normalize(input: String): Result {
        var value = input.trim().trimEnd('/')
        if (value.isEmpty()) return Result.Invalid("Bitte die Adresse der Instanz eingeben.")
        if (value.startsWith("http://", ignoreCase = true)) {
            return Result.Invalid("Nur HTTPS-Adressen sind erlaubt.")
        }
        if (!value.startsWith("https://", ignoreCase = true)) value = "https://$value"
        val rest = value.substring("https://".length)
        val host = rest.substringBefore('/').substringBefore('?').substringBefore('#')
        if (host.isEmpty() || host.contains('@') || host.contains(' ') || rest.contains('?') || rest.contains('#')) {
            return Result.Invalid("Ungültige Adresse.")
        }
        val hostname = host.substringBefore(':')
        val port = host.substringAfter(':', "")
        if (hostname.isEmpty() || (port.isNotEmpty() && port.toIntOrNull()?.takeIf { it in 1..65535 } == null)) {
            return Result.Invalid("Ungültige Adresse.")
        }
        // An address ending in /api is accepted and reduced to the instance root.
        val path = rest.substring(host.length).removeSuffix("/api")
        return Result.Ok("https://${host.lowercase()}$path")
    }
}
