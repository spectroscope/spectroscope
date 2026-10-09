package dev.spectroscope.server.web;

import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 472: the one-shot tickets behind the "Graph ready" chip. The server
 * mints one when the operator presses the chip, the browser fence lets the
 * code graph view through only while it is live, and the view spends it on
 * the first load.
 */
class AppPageTicketsTest {

    private final AtomicLong now = new AtomicLong(1_000_000L);
    private final AppPageTickets tickets = new AppPageTickets(now::get);

    @Test
    void aMintedTicketIsLiveUntilTheViewSpendsIt() {
        String ticket = tickets.mint("s-1");

        assertTrue(ticket.matches("[0-9a-f]{32}"), ticket);
        assertTrue(tickets.isLive(ticket));
        assertTrue(tickets.redeem(ticket, "s-1"), "the first load is served");
        assertFalse(tickets.isLive(ticket), "a spent ticket passes the fence no more");
        assertFalse(tickets.redeem(ticket, "s-1"), "and a second load is not served");
    }

    @Test
    void aTicketServesOnlyTheSessionItWasMintedFor() {
        String ticket = tickets.mint("s-1");

        assertFalse(tickets.redeem(ticket, "s-2"), "another session's graph is not this ticket's");
        assertFalse(tickets.isLive(ticket), "a wrong try spends it too, so it cannot be guessed twice");
    }

    @Test
    void aTicketDiesAfterItsLifetime() {
        String ticket = tickets.mint("s-1");
        now.addAndGet(AppPageTickets.LIFETIME_MS);

        assertFalse(tickets.isLive(ticket));
        assertFalse(tickets.redeem(ticket, "s-1"));
    }

    @Test
    void noTicketAndAnUnknownTicketAreNeverLive() {
        tickets.mint("s-1");

        assertFalse(tickets.isLive(null));
        assertFalse(tickets.isLive(""));
        assertFalse(tickets.isLive("0123456789abcdef0123456789abcdef"));
        assertFalse(tickets.redeem(null, "s-1"));
    }

    @Test
    void everyPressMintsADifferentTicket() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 200; i++) {
            seen.add(tickets.mint("s-1"));
        }
        assertEquals(200, seen.size());
    }

    @Test
    void theViewAddressIsTheServersOwnLoopbackPortWithTheTicket() {
        String address = tickets.viewAddress("20260814-120000-cafecafe", 8473);

        String prefix = "http://localhost:8473/api/codegraph/view?sessionId=20260814-120000-cafecafe&ticket=";
        assertTrue(address.startsWith(prefix), address);
        assertTrue(tickets.isLive(address.substring(prefix.length())), address);
    }
}
