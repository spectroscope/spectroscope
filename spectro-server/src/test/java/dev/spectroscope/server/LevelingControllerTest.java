package dev.spectroscope.server;

import dev.spectroscope.core.leveling.Ladder;
import dev.spectroscope.core.leveling.LevelingRecorder;
import dev.spectroscope.core.leveling.LevelingState;
import dev.spectroscope.core.leveling.LevelingStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The REST face of the ladder. Two things it must get right: every write wears
 * the full local fence (a page on another origin cannot silently level up
 * somebody's install, nor read what they have been doing), and nothing here
 * ever ENFORCES a level. The endpoints report and record; locks are the
 * client's rendering decision, so the API behaves identically at level 0 and
 * level 6.
 */
class LevelingControllerTest {

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();   // 127.0.0.1 + localhost by default
    }

    private static MockHttpServletRequest foreign() {
        MockHttpServletRequest request = local();
        request.addHeader("Origin", "http://evil.example");
        return request;
    }

    private static MockHttpServletRequest rebound() {
        MockHttpServletRequest request = local();
        request.setServerName("attacker.example.com");
        return request;
    }

    private LevelingController controller(Path dir) {
        return new LevelingController(new LevelingRecorder(
                Ladder.bundled(), new LevelingStore(dir.resolve("leveling.json")),
                LevelingState.Mode.LADDER));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> body(ResponseEntity<Map<String, Object>> response) {
        return (Map<String, Object>) response.getBody();
    }

    @Test
    void reportsTheLadderAndTheState(@TempDir Path dir) {
        Map<String, Object> answer = body(controller(dir).state(local()));
        assertEquals("ladder", answer.get("mode"));
        assertEquals(0, answer.get("level"));
        assertEquals("dark-frame", answer.get("levelId"));
        assertNotNull(answer.get("ladder"), "the client renders from the same single source");
        assertTrue(((java.util.List<?>) answer.get("remaining")).contains("provider-ready"));
    }

    @Test
    void aBeaconMarksAndTheStateShowsIt(@TempDir Path dir) {
        LevelingController controller = controller(dir);
        ResponseEntity<Map<String, Object>> posted =
                controller.visit(new LevelingController.VisitBody("replay", null), local());
        assertEquals(200, posted.getStatusCode().value());
        Map<String, Object> marks = (Map<String, Object>) body(controller.state(local())).get("marks");
        assertTrue(marks.containsKey("replay-scrubbed"));
    }

    @Test
    void aHandTickIsRecordedAsManual(@TempDir Path dir) {
        LevelingController controller = controller(dir);
        controller.tick(new LevelingController.TickBody("lens-used"), local());
        Map<String, Object> marks = (Map<String, Object>) body(controller.state(local())).get("marks");
        Map<String, Object> mark = (Map<String, Object>) marks.get("lens-used");
        assertEquals("manual", mark.get("origin"), "a receipt never pretends a hand tick was observed");
    }

    @Test
    void modeSwitchesAndSurvivesInTheStore(@TempDir Path dir) {
        LevelingController controller = controller(dir);
        controller.mode(new LevelingController.ModeBody("checklist"), local());
        assertEquals("checklist", body(controller.state(local())).get("mode"));

        LevelingState reloaded = new LevelingStore(dir.resolve("leveling.json")).read().orElseThrow();
        assertEquals(LevelingState.Mode.CHECKLIST, reloaded.mode(), "the choice is server state, not a cookie");
    }

    @Test
    void resetGoesBackToTheDarkFrameButKeepsTheChosenMode(@TempDir Path dir) {
        LevelingController controller = controller(dir);
        controller.mode(new LevelingController.ModeBody("checklist"), local());
        controller.tick(new LevelingController.TickBody("provider-ready"), local());
        assertEquals(1, body(controller.state(local())).get("level"));

        controller.reset(local());
        Map<String, Object> after = body(controller.state(local()));
        assertEquals(0, after.get("level"));
        assertTrue(((Map<?, ?>) after.get("marks")).isEmpty());
        assertEquals("checklist", after.get("mode"), "a restart of the ladder is not a change of mind about it");
    }

    @Test
    void aResetReachesTheDiskEvenWhileTrackingIsOff(@TempDir Path dir) {
        // Off suppresses tracking writes, and reset is not tracking: it is an operator
        // asking to start over. Wiping only memory would answer 200 to a reset the
        // next restart quietly undoes.
        Path file = dir.resolve("leveling.json");
        LevelingController controller = controller(dir);
        controller.tick(new LevelingController.TickBody("provider-ready"), local());
        controller.mode(new LevelingController.ModeBody("off"), local());
        controller.reset(local());

        LevelingState onDisk = new LevelingStore(file).read().orElseThrow();
        assertTrue(onDisk.marks().isEmpty(), "the wipe reached the file, not just the field");
        assertEquals(LevelingState.Mode.OFF, onDisk.mode(), "and it left the mode alone");
    }

    @Test
    void anUnknownModeIsRefusedRatherThanGuessed(@TempDir Path dir) {
        LevelingController controller = controller(dir);
        assertEquals(400, controller.mode(new LevelingController.ModeBody("sideways"), local())
                .getStatusCode().value());
        assertEquals("ladder", body(controller.state(local())).get("mode"));
    }

    @Test
    void everyWriteBouncesAForeignOriginWithoutATrace(@TempDir Path dir) {
        LevelingController controller = controller(dir);
        assertEquals(404, controller.visit(new LevelingController.VisitBody("replay", null), foreign())
                .getStatusCode().value());
        assertEquals(404, controller.tick(new LevelingController.TickBody("lens-used"), foreign())
                .getStatusCode().value());
        assertEquals(404, controller.mode(new LevelingController.ModeBody("off"), foreign())
                .getStatusCode().value());
        assertEquals(404, controller.reset(foreign()).getStatusCode().value());

        Map<String, Object> untouched = body(controller.state(local()));
        assertTrue(((Map<?, ?>) untouched.get("marks")).isEmpty(), "nothing a foreign page posted stuck");
        assertEquals("ladder", untouched.get("mode"));
    }

    @Test
    void readingIsFencedToo(@TempDir Path dir) {
        assertEquals(404, controller(dir).state(foreign()).getStatusCode().value());
        assertNull(controller(dir).state(foreign()).getBody());
    }

    @Test
    void aRebindingHostIsRefused(@TempDir Path dir) {
        LevelingController controller = controller(dir);
        assertEquals(404, controller.visit(new LevelingController.VisitBody("replay", null), rebound())
                .getStatusCode().value());
        assertEquals(404, controller.state(rebound()).getStatusCode().value());
    }

    @Test
    void anUnknownSurfaceIsAcceptedButChangesNothing(@TempDir Path dir) {
        LevelingController controller = controller(dir);
        ResponseEntity<Map<String, Object>> answer =
                controller.visit(new LevelingController.VisitBody("teapot", null), local());
        assertEquals(200, answer.getStatusCode().value(), "a face from a newer build is not an attack");
        assertTrue(((Map<?, ?>) body(controller.state(local())).get("marks")).isEmpty());
    }

    @Test
    void offStopsTrackingWithoutHidingTheLadder(@TempDir Path dir) {
        LevelingController controller = controller(dir);
        controller.mode(new LevelingController.ModeBody("off"), local());
        controller.visit(new LevelingController.VisitBody("replay", null), local());

        Map<String, Object> answer = body(controller.state(local()));
        assertEquals("off", answer.get("mode"));
        assertNotNull(answer.get("ladder"), "the ladder is public knowledge even when nobody is scoring");
        assertTrue(((Map<?, ?>) answer.get("marks")).isEmpty());
    }

    @Test
    void freshHomeDetectionPicksTheLadderOnlyForAnUntouchedHome(@TempDir Path dir) throws Exception {
        Path sessions = dir.resolve("sessions");
        Path settings = dir.resolve("settings.json");
        assertEquals(LevelingState.Mode.LADDER, ServerLeveling.freshMode(sessions, settings),
                "nothing here yet: offer the ladder");

        java.nio.file.Files.createDirectories(sessions);
        assertEquals(LevelingState.Mode.LADDER, ServerLeveling.freshMode(sessions, settings),
                "an empty sessions folder is still an untouched home");

        java.nio.file.Files.writeString(sessions.resolve("20260101-old.jsonl"), "{}\n");
        assertEquals(LevelingState.Mode.CHECKLIST, ServerLeveling.freshMode(sessions, settings),
                "somebody has already run agents here: never lock surfaces away from them");
    }

    @Test
    void anExistingSettingsFileAlsoMeansAnExperiencedHome(@TempDir Path dir) throws Exception {
        Path sessions = dir.resolve("sessions");
        Path settings = dir.resolve("settings.json");
        java.nio.file.Files.writeString(settings, "{}");
        assertEquals(LevelingState.Mode.CHECKLIST, ServerLeveling.freshMode(sessions, settings));
    }

    @Test
    void aFreshHomeIsAskedOnceAndAResetDoesNotAskAgain(@TempDir Path dir) {
        LevelingController controller = controller(dir);
        assertEquals(false, body(controller.state(local())).get("introSeen"),
                "a pristine home has not answered yet");

        // Choosing a mode IS the answer, whichever way it goes.
        controller.mode(new LevelingController.ModeBody("ladder"), local());
        assertEquals(true, body(controller.state(local())).get("introSeen"));

        controller.reset(local());
        assertEquals(true, body(controller.state(local())).get("introSeen"),
                "restarting the ladder is not re-onboarding");
    }

    @Test
    void theServerNeverEnforcesALevel(@TempDir Path dir) {
        // The whole API surface answers the same at level 0 as at level 6. This test pins the
        // architectural promise from card 79: locks are client rendering, never server policy.
        LevelingController controller = controller(dir);
        Map<String, Object> atZero = body(controller.state(local()));
        for (String criterion : new String[] {"provider-ready", "first-run-complete", "session-reopened",
                "trace-opened", "replay-scrubbed", "disclosure-expanded", "mode-set", "gate-answered"}) {
            controller.tick(new LevelingController.TickBody(criterion), local());
        }
        Map<String, Object> atFour = body(controller.state(local()));
        assertEquals(atZero.keySet(), atFour.keySet(), "same shape, more marks");
        assertFalse(atZero.containsKey("denied"));
        assertTrue((int) atFour.get("level") > (int) atZero.get("level"));
    }
}
