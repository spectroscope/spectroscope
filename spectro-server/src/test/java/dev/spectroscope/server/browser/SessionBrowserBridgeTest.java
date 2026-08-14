package dev.spectroscope.server.browser;

import dev.spectroscope.core.launch.LaunchSupervisor;
import dev.spectroscope.core.wire.BrowserWireTap;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The bridge between a live session's socket half and the browser's operator
 * half (card 227): the view socket needs the session's sidecar recorder, its
 * launch supervisor and its project folder, and the fight rule needs to know
 * whether an AGENT browser call is in flight right now.
 */
class SessionBrowserBridgeTest {

    private static final String SESSION = "20260814-130000-feedbeef";

    private static SessionBrowserBridge.Live entry() {
        return new SessionBrowserBridge.Live(BrowserWireTap.none(),
                new LaunchSupervisor((host, port) -> true), () -> Path.of("/tmp"));
    }

    @Test
    void aRegisteredSessionAnswersItsEntryAndUnregisterForgets() {
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        assertNull(bridge.live(SESSION), "an unknown session answers null, never a default");
        SessionBrowserBridge.Live live = entry();
        bridge.register(SESSION, live);
        assertEquals(live, bridge.live(SESSION));
        bridge.unregister(SESSION);
        assertNull(bridge.live(SESSION));
    }

    @Test
    void theAgentGuardMarksDrivingExactlyWhileACallIsInFlight() {
        // The fight rule's ground truth (criterion 5): "an agent is driving"
        // is measured on the same seam that records the call, so the two facts
        // cannot disagree. Before open: free. Between open and end: driving.
        // After end: free again.
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        BrowserWireTap guarded = bridge.agentGuard(() -> SESSION, BrowserWireTap::none);

        assertFalse(bridge.agentDriving(SESSION), "nothing has opened yet");
        BrowserWireTap.Call call = guarded.open("browser_navigate", "main", "t1", null, null);
        assertTrue(bridge.agentDriving(SESSION), "an open call is an agent driving");
        call.end(true, "opened", null);
        assertFalse(bridge.agentDriving(SESSION), "the call ended, the operator may drive");
    }

    @Test
    void twoOverlappingAgentCallsKeepTheSessionDrivingUntilBothEnd() {
        // Parallel subagents share one session browser; the flag is a count,
        // not a boolean, or the first end would unlock mid-flight.
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        BrowserWireTap guarded = bridge.agentGuard(() -> SESSION, BrowserWireTap::none);
        BrowserWireTap.Call first = guarded.open("browser_eval", "a", "t1", null, null);
        BrowserWireTap.Call second = guarded.open("browser_eval", "b", "t2", null, null);
        first.end(true, "1", null);
        assertTrue(bridge.agentDriving(SESSION), "one of two calls is still in flight");
        second.end(true, "2", null);
        assertFalse(bridge.agentDriving(SESSION));
    }

    @Test
    void aDoubleEndDecrementsOnce() {
        // The recorder tolerates a failure racing a natural close by ending
        // once; the guard must not let that second end free a count it never
        // took, or a later call's lock would be released early.
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        BrowserWireTap guarded = bridge.agentGuard(() -> SESSION, BrowserWireTap::none);
        BrowserWireTap.Call first = guarded.open("browser_eval", "a", "t1", null, null);
        BrowserWireTap.Call second = guarded.open("browser_eval", "b", "t2", null, null);
        first.end(true, "1", null);
        first.end(true, "1", null);
        assertTrue(bridge.agentDriving(SESSION),
                "the second call is still in flight — a double end must not free it");
        second.end(true, "2", null);
        assertFalse(bridge.agentDriving(SESSION));
    }

    @Test
    void aSessionlessCallGuardsNothingAndStillRecords() {
        // The CLI shape: no session id yet. The guard must not throw and must
        // not poison some shared key.
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        BrowserWireTap guarded = bridge.agentGuard(() -> null, BrowserWireTap::none);
        BrowserWireTap.Call call = guarded.open("browser_eval", "a", "t1", null, null);
        assertFalse(bridge.agentDriving(null));
        call.end(true, "1", null);
    }
}
