package dev.spectroscope.orchestrator;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 585: the two hub settings and what the server makes of them. The hub
 * never binds a port under 1024, never takes the app's own 8080 to 8100, and no
 * value ever throws: a hub that cannot open is off with a reason.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class HubSettingsTest {

    /** A loopback listener on an OS-assigned port, the way another program holds one. */
    private static ServerSocket hold() throws IOException {
        ServerSocket held = new ServerSocket();
        held.bind(new java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
        return held;
    }

    @Test
    void nothingSetKeepsTheHubOff() {
        HubSettings.Plan plan = HubSettings.plan(null, null);
        assertFalse(plan.on());
        assertEquals(HubSettings.Note.NONE, plan.note());
        assertFalse(HubSettings.plan("", "  ").on());
    }

    @Test
    void theSwitchReadsTrueOnYesAndFalseOffNoInAnyCase() {
        for (String on : List.of("true", "TRUE", "on", "On", "yes", "YES", " true ", "1")) {
            HubSettings.Plan plan = HubSettings.plan(on, "");
            assertTrue(plan.on(), on + " turns the hub on");
            assertTrue(plan.pick(), "no port written: the hub picks one");
            assertEquals(HubSettings.DEFAULT_PORT, plan.pickFrom());
            assertEquals(7700, plan.pickFrom(), "the default is 7700");
        }
        for (String off : List.of("false", "FALSE", "off", "Off", "no", "NO", "0")) {
            assertFalse(HubSettings.plan(off, "7744").on(), off + " keeps the hub off, even with a port");
        }
    }

    @Test
    void anExplicitFalseWinsOverEveryPort() {
        for (String port : List.of("1", "7744", "0", "abc")) {
            HubSettings.Plan plan = HubSettings.plan("false", port);
            assertFalse(plan.on(), "SPECTRO_HUB_ENABLED=false with SPECTRO_HUB_PORT=" + port);
            assertEquals(HubSettings.Note.NONE, plan.note());
        }
    }

    @Test
    void aSwitchWordItCannotReadKeepsTheHubOffAndSaysSo() {
        HubSettings.Plan plan = HubSettings.plan("maybe", "7744");
        assertFalse(plan.on());
        assertEquals(HubSettings.Note.ENABLED_UNREADABLE, plan.note());
        assertTrue(HubSettings.open(plan).describe().contains("maybe"));
    }

    @Test
    void aPortWithoutTheSwitchStillTurnsTheHubOnTheOldWay() {
        HubSettings.Plan plan = HubSettings.plan(null, "7744");
        assertTrue(plan.on(), "SPECTRO_HUB_PORT alone is the old opt-in and keeps working");
        assertFalse(plan.pick());
        assertEquals(7744, plan.writtenPort());
    }

    @Test
    void everyPortUnder1024IsNeverBoundAndPicksFrom7700() {
        for (int port = 1; port < 1024; port++) {
            HubSettings.Plan plan = HubSettings.plan(null, String.valueOf(port));
            assertTrue(plan.on(), "port " + port + " still means a hub");
            assertTrue(plan.pick(), "port " + port + " is never bound as written");
            assertEquals(7700, plan.pickFrom());
            assertEquals(HubSettings.Note.PORT_PRIVILEGED, plan.note());
        }
        // The owner's file: SPECTRO_HUB_PORT=1, no switch.
        assertTrue(HubSettings.plan("true", "1").pick());
    }

    @Test
    void anUnreadablePortPicksFrom7700Too() {
        for (String bad : List.of("abc", "70000", "-1", "80 80", "true")) {
            HubSettings.Plan plan = HubSettings.plan("true", bad);
            assertTrue(plan.on());
            assertTrue(plan.pick(), bad + " is never bound");
            assertEquals(HubSettings.Note.PORT_INVALID, plan.note());
        }
    }

    @Test
    void aPortFrom1024UpIsUsedAsWritten() {
        assertEquals(1024, HubSettings.plan("true", "1024").writtenPort());
        assertEquals(65535, HubSettings.plan("true", "65535").writtenPort());
        assertFalse(HubSettings.plan("true", "1024").pick());
        // 0 keeps its meaning: an OS-assigned port, which is never under 1024.
        assertEquals(0, HubSettings.plan("true", "0").writtenPort());
        assertFalse(HubSettings.plan("true", "0").pick());
    }

    @Test
    void thePickNeverWalksUnder1024NorIntoTheAppsOwnRange() {
        assertEquals(7700, HubSettings.firstCandidate(7700));
        assertEquals(1024, HubSettings.firstCandidate(1));
        assertEquals(8101, HubSettings.firstCandidate(8080));
        assertEquals(8101, HubSettings.firstCandidate(8100));
        assertEquals(8079, HubSettings.firstCandidate(8079));
        assertEquals(8101, HubSettings.nextCandidate(8079));
        assertEquals(7701, HubSettings.nextCandidate(7700));
        assertEquals(-1, HubSettings.nextCandidate(65535), "the walk ends at 65535");
        List<Integer> walk = new ArrayList<>();
        for (int p = HubSettings.firstCandidate(8070); p != -1 && walk.size() < 40; p = HubSettings.nextCandidate(p)) {
            walk.add(p);
        }
        assertEquals(40, walk.size());
        assertTrue(walk.contains(8079));
        assertTrue(walk.contains(8101));
        for (int p : walk) {
            assertFalse(p >= 8080 && p <= 8100, "the walk took " + p);
            assertTrue(p >= 1024);
        }
    }

    @Test
    void aWrittenPortHeldByAnotherSocketLeavesTheHubOffWithTheReason() throws Exception {
        try (ServerSocket held = hold()) {
            int port = held.getLocalPort();
            HubSettings.Outcome outcome = HubSettings.open(HubSettings.plan("true", String.valueOf(port)));
            assertNull(outcome.hub(), "no hub on a port another socket holds");
            assertEquals(-1, outcome.port());
            assertEquals(HubSettings.Note.BIND_FAILED, outcome.note());
            assertNotNull(outcome.reason());
            assertFalse(outcome.reason().isBlank());
            String said = outcome.describe();
            assertTrue(said.contains(String.valueOf(port)), said);
            assertTrue(said.contains(outcome.reason()), said);
        }
    }

    @Test
    void thePickSkipsAPortAnotherSocketHolds() throws Exception {
        try (ServerSocket held = hold()) {
            int start = held.getLocalPort();
            HubSettings.Plan plan = HubSettings.plan("true", "1", start);
            HubSettings.Outcome outcome = HubSettings.open(plan);
            try {
                assertNotNull(outcome.hub());
                assertNotEquals(start, outcome.port(), "the held port is skipped");
                assertTrue(outcome.port() > start);
                assertEquals(outcome.hub().port(), outcome.port());
                assertEquals(HubSettings.Note.PORT_PRIVILEGED, outcome.note());
                String said = outcome.describe();
                assertTrue(said.contains("SPECTRO_HUB_PORT=1"), said);
                assertTrue(said.contains(String.valueOf(outcome.port())), said);
            } finally {
                outcome.hub().close();
            }
        }
    }

    @Test
    void theDefaultTakenIsNamedWhenNoPortWasWritten() throws Exception {
        try (ServerSocket held = hold()) {
            int start = held.getLocalPort();
            HubSettings.Outcome outcome = HubSettings.open(HubSettings.plan("true", "", start));
            try {
                assertEquals(HubSettings.Note.DEFAULT_TAKEN, outcome.note());
                assertTrue(outcome.describe().contains(String.valueOf(start)));
            } finally {
                outcome.hub().close();
            }
        }
    }

    @Test
    void portZeroOpensAnOsAssignedPort() throws Exception {
        HubSettings.Outcome outcome = HubSettings.open(HubSettings.plan(null, "0"));
        try {
            assertTrue(outcome.port() >= 1024, "an OS-assigned port, got " + outcome.port());
            assertEquals(HubSettings.Note.NONE, outcome.note());
        } finally {
            outcome.hub().close();
        }
    }

    @Test
    void anOffPlanOpensNothing() {
        HubSettings.Outcome outcome = HubSettings.open(HubSettings.plan("off", "7744"));
        assertNull(outcome.hub());
        assertEquals(-1, outcome.port());
    }

    private static String said(HubSettings.Plan plan, int port, HubSettings.Note note, String reason) {
        return new HubSettings.Outcome(plan, null, port, note, reason).describe();
    }

    @Test
    void theSentencesCarryNoDashes() throws Exception {
        List<String> said = new ArrayList<>();
        said.add(HubSettings.open(HubSettings.plan(null, null)).describe());
        said.add(HubSettings.open(HubSettings.plan("false", "1")).describe());
        said.add(HubSettings.open(HubSettings.plan("maybe", "")).describe());
        said.add(said(HubSettings.plan(null, "1"), 7700, HubSettings.Note.PORT_PRIVILEGED, null));
        said.add(said(HubSettings.plan(null, "abc"), 7700, HubSettings.Note.PORT_INVALID, null));
        said.add(said(HubSettings.plan("true", "7744"), 7744, HubSettings.Note.NONE, null));
        said.add(said(HubSettings.plan("true", "7744"), -1, HubSettings.Note.BIND_FAILED, "Address already in use"));
        said.add(said(HubSettings.plan("true", ""), 7701, HubSettings.Note.DEFAULT_TAKEN, null));
        said.add(said(HubSettings.plan("true", ""), -1, HubSettings.Note.NO_FREE_PORT, null));
        said.add(said(HubSettings.plan("true", "8080"), 7700, HubSettings.Note.PORT_APP_RANGE, null));
        said.add(said(HubSettings.plan("true", "7790", 7700, 7790), 7700, HubSettings.Note.PORT_SERVER, null));
        said.add(said(HubSettings.unreadable("SPECTRO_HUB_ENABLED", "Could not resolve placeholder 'nope'"),
                -1, HubSettings.Note.SETTING_UNREADABLE, null));
        for (String s : said) {
            assertFalse(s.contains("\u2014") || s.contains("\u2013") || s.contains("--"), s);
            assertFalse(s.isBlank());
        }
    }

    // Fix round (review D1): the app's own range and the server's own port.

    @Test
    void aPortInTheAppsOwnRangeIsNeverBoundAndPicksFrom7700() {
        for (int port : new int[] {8080, 8090, 8100}) {
            HubSettings.Plan plan = HubSettings.plan("true", String.valueOf(port));
            assertTrue(plan.on());
            assertTrue(plan.pick(), port + " is never bound as written");
            assertEquals(HubSettings.Note.PORT_APP_RANGE, plan.note());
            assertEquals("app-range", HubSettings.portProblem(String.valueOf(port)));
        }
        assertFalse(HubSettings.plan("true", "8079").pick());
        assertFalse(HubSettings.plan("true", "8101").pick());
        assertNull(HubSettings.portProblem("8101"));
    }

    @Test
    void theServersOwnPortIsNeverBoundAndPicksFrom7700() {
        HubSettings.Plan plan = HubSettings.plan("true", "7790", HubSettings.DEFAULT_PORT, 7790);
        assertTrue(plan.on());
        assertTrue(plan.pick(), "the server's own port is never bound by the hub");
        assertEquals(HubSettings.Note.PORT_SERVER, plan.note());
        assertEquals("server-port", HubSettings.portProblem("7790", 7790));
        assertNull(HubSettings.portProblem("7791", 7790));
        assertFalse(HubSettings.plan("true", "7791", HubSettings.DEFAULT_PORT, 7790).pick());
        // 0 means "not known yet" (a random test port): nothing is refused for it.
        assertNull(HubSettings.portProblem("7790", 0));
    }

    @Test
    void theWalkSkipsTheServersOwnPort() {
        assertEquals(7701, HubSettings.firstCandidate(7700, 7700));
        assertEquals(7701, HubSettings.nextCandidate(7699, 7700));
        assertEquals(8102, HubSettings.firstCandidate(8080, 8101));
        assertEquals(7700, HubSettings.firstCandidate(7700, 0));
    }

    // Fix round (review D2): a holder on the wildcard is a holder.

    private static ServerSocket holdOn(String address) throws IOException {
        ServerSocket held = new ServerSocket();
        held.bind(new InetSocketAddress(InetAddress.getByName(address), 0));
        return held;
    }

    private static boolean ipv6() {
        try (ServerSocket probe = new ServerSocket()) {
            probe.bind(new InetSocketAddress(InetAddress.getByName("::1"), 0));
            return true;
        } catch (IOException none) {
            return false;
        }
    }

    @Test
    void aPortHeldOnTheIpv4WildcardIsNotFreeAndNotBound() throws Exception {
        try (ServerSocket held = holdOn("0.0.0.0")) {
            int port = held.getLocalPort();
            assertFalse(HubSettings.free(port), "0.0.0.0:" + port + " is held");
            HubSettings.Outcome written = HubSettings.open(HubSettings.plan("true", String.valueOf(port)));
            assertNull(written.hub(), "no hub next to another program's listener");
            assertEquals(HubSettings.Note.BIND_FAILED, written.note());
            HubSettings.Outcome walked = HubSettings.open(HubSettings.plan("true", "", port));
            try {
                assertNotEquals(port, walked.port(), "the walk skips a wildcard holder");
                assertEquals(HubSettings.Note.DEFAULT_TAKEN, walked.note());
            } finally {
                if (walked.hub() != null) {
                    walked.hub().close();
                }
            }
        }
    }

    @Test
    void aPortHeldOnTheIpv6WildcardIsNotFreeAndNotBound() throws Exception {
        assumeTrue(ipv6(), "this machine has no IPv6 loopback");
        try (ServerSocket held = holdOn("::")) {
            int port = held.getLocalPort();
            assertFalse(HubSettings.free(port), "[::]:" + port + " is held");
            HubSettings.Outcome written = HubSettings.open(HubSettings.plan("true", String.valueOf(port)));
            assertNull(written.hub());
            assertEquals(HubSettings.Note.BIND_FAILED, written.note());
        }
    }

    // Fix round (review D7): a walk that finds nothing returns, it never throws.

    @Test
    void aBinderThatAlwaysFailsEndsInNoFreePortWithoutAThrow() {
        HubSettings.Binder busy = port -> {
            throw new IOException("busy");
        };
        HubSettings.Outcome walked = HubSettings.open(HubSettings.plan("true", "", 65530), busy);
        assertNull(walked.hub());
        assertEquals(-1, walked.port());
        assertEquals(HubSettings.Note.NO_FREE_PORT, walked.note());
        HubSettings.Binder broken = port -> {
            throw new IllegalStateException("broken");
        };
        HubSettings.Outcome written = HubSettings.open(HubSettings.plan("true", "7745"), broken);
        assertNull(written.hub());
        assertEquals(HubSettings.Note.BIND_FAILED, written.note());
        assertEquals("broken", written.reason());
    }
}
