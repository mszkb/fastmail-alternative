package net.fma.mail

import net.fma.mail.api.InstanceUrl
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class InstanceUrlTest {
    private fun ok(input: String) = assertIs<InstanceUrl.Result.Ok>(InstanceUrl.normalize(input)).baseUrl

    @Test
    fun addsHttpsAndStripsTrailingSlashAndApi() {
        assertEquals("https://mail.example.org", ok("mail.example.org"))
        assertEquals("https://mail.example.org", ok(" https://Mail.Example.org/ "))
        assertEquals("https://mail.example.org:8443", ok("https://mail.example.org:8443/api"))
        assertEquals("https://example.org/mail", ok("https://example.org/mail/"))
    }

    @Test
    fun rejectsHttpAndGarbage() {
        assertIs<InstanceUrl.Result.Invalid>(InstanceUrl.normalize("http://mail.example.org"))
        assertIs<InstanceUrl.Result.Invalid>(InstanceUrl.normalize(""))
        assertIs<InstanceUrl.Result.Invalid>(InstanceUrl.normalize("https://user@mail.example.org"))
        assertIs<InstanceUrl.Result.Invalid>(InstanceUrl.normalize("https://mail.example.org:99999"))
        assertIs<InstanceUrl.Result.Invalid>(InstanceUrl.normalize("https://mail.example.org/?x=1"))
    }
}
