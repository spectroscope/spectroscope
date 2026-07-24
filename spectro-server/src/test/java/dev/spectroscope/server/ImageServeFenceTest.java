package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The image byte serve ({@code GET /api/images/{file}}) wears the loopback+Host
 * read fence: an image can carry sensitive visual content and its name is
 * discoverable from the session events, so it must not rest on name-obscurity.
 * The fence runs BEFORE the name contract, so a rebound caller learns nothing —
 * not even whether a name is well-formed.
 */
class ImageServeFenceTest {

    private final SessionsController controller = new SessionsController();

    private static final String VALID = "a".repeat(64) + ".png";

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    @Test
    void refusesADnsReboundHostBeforeTheNameCheck() {
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        assertEquals(404, controller.image(VALID, rebound).getStatusCode().value());
    }

    @Test
    void refusesANonLocalCaller() {
        MockHttpServletRequest remote = local();
        remote.setRemoteAddr("203.0.113.7"); // TEST-NET, not loopback
        assertEquals(404, controller.image(VALID, remote).getStatusCode().value());
    }

    @Test
    void aLocalCallerPassesTheFenceAndHitsTheNameContract() {
        // A malformed name from a local caller is a 400 (the contract), proving
        // the fence let it through — not the blanket 404 a remote caller gets.
        assertEquals(400, controller.image("../secret", local()).getStatusCode().value());
    }
}
