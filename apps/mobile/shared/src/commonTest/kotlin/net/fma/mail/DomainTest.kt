package net.fma.mail

import net.fma.mail.api.AccountSummary
import net.fma.mail.api.MailPerson
import net.fma.mail.api.MessageDetail
import net.fma.mail.api.MessageFlags
import net.fma.mail.domain.SyncThrottle
import net.fma.mail.domain.accountsWithNewMail
import net.fma.mail.domain.badgeCount
import net.fma.mail.domain.forward
import net.fma.mail.domain.parseRecipients
import net.fma.mail.domain.replyAll
import net.fma.mail.domain.replySubject
import net.fma.mail.domain.replyTo
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DomainTest {
    private fun account(id: String, unread: Int) = AccountSummary(id, id, "$id@example.org", "ok", unreadCount = unread)

    @Test
    fun throttleAllowsStartAndThenEvery15Seconds() {
        val throttle = SyncThrottle()
        assertTrue(throttle.shouldSync(0))
        assertFalse(throttle.shouldSync(10_000))
        assertTrue(throttle.shouldSync(10_000, force = true))
        assertTrue(throttle.shouldSync(25_001))
    }

    @Test
    fun newMailDetectionAndBadge() {
        val current = listOf(account("a", 3), account("b", 1), account("c", 5))
        assertEquals(listOf("a"), accountsWithNewMail(mapOf("a" to 2, "b" to 1), current))
        assertEquals(9, badgeCount(current))
    }

    @Test
    fun replyPrefill() {
        assertEquals("Re: Hallo", replySubject("Hallo"))
        assertEquals("RE: Hallo", replySubject("RE: Hallo"))
        val message = MessageDetail(
            id = "m", accountId = "a", subject = "Hallo", from = MailPerson("Ann", "ann@example.org"),
            date = "2026-10-09T10:00:00Z", flags = MessageFlags(true, false), messageId = "<1@x>",
            references = listOf("<0@x>"), text = "Zeile 1\nZeile 2",
        )
        val draft = replyTo(message)
        assertEquals("ann@example.org", draft.to)
        assertEquals(listOf("<0@x>", "<1@x>"), draft.references)
        assertTrue(draft.body.contains("> Zeile 2"))
        assertEquals(listOf("a@x.org", "b@y.org"), parseRecipients("a@x.org, b@y.org;"))
    }

    @Test
    fun replyAllAndForward() {
        val message = MessageDetail(
            id = "m", accountId = "a", subject = "Plan", from = MailPerson("Ann", "ann@example.org"),
            to = listOf(MailPerson("", "Me@Example.org"), MailPerson("", "bob@example.org")),
            cc = listOf(MailPerson("", "ann@example.org"), MailPerson("", "carl@example.org")),
            date = "2026-10-09T10:00:00Z", flags = MessageFlags(true, false), text = "Inhalt",
        )
        val (draft, cc) = replyAll(message, listOf("me@example.org"))
        assertEquals("ann@example.org", draft.to)
        assertEquals("bob@example.org, carl@example.org", cc)
        val fwd = forward(message)
        assertEquals("Fwd: Plan", fwd.subject)
        assertEquals("", fwd.to)
        assertTrue(fwd.body.contains("Von: Ann <ann@example.org>") && fwd.body.endsWith("Inhalt"))
    }
}
