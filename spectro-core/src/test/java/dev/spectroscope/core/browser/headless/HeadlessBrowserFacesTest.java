package dev.spectroscope.core.browser.headless;

import dev.spectroscope.core.browser.BrowserFace;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The web face's directory (card 226): every session's headless browser, keyed
 * by session id, with card 218's isolation carried by the PROFILE DIRECTORY the
 * way the desktop carries it by Electron partition — one per session id, a
 * fresh one per opening, gone when the session closes.
 */
class HeadlessBrowserFacesTest {

    /** An engine that records being opened and killed, and opens no Chrome. */
    private static final class FakeEngines implements HeadlessBrowserFaces.EngineOpener {
        final List<String> opened = new CopyOnWriteArrayList<>();
        final List<Path> profiles = new CopyOnWriteArrayList<>();
        final List<Path> killed = new CopyOnWriteArrayList<>();

        @Override
        public HeadlessBrowserFaces.Engine open(String sessionId, Path profileDir) {
            opened.add(sessionId);
            profiles.add(profileDir);
            return new HeadlessBrowserFaces.Engine() {
                @Override
                public HeadlessBrowserFace.Cdp cdp() {
                    return new HeadlessBrowserFaceTest.FakeCdp();
                }

                @Override
                public void kill() {
                    killed.add(profileDir);
                }
            };
        }
    }

    private static HeadlessBrowserFaces directory(Path base, FakeEngines engines) {
        return new HeadlessBrowserFaces(() -> Optional.of(Path.of("/usr/bin/true")),
                base, url -> null, engines);
    }

    @Test
    void aSessionGetsItsOwnFaceAndKeepsItUntilTheSessionCloses(@TempDir Path base) {
        HeadlessBrowserFaces faces = directory(base, new FakeEngines());
        BrowserFace first = faces.forSession("s-1");
        assertSame(first, faces.forSession("s-1"), "one browser per session, not per call");
        assertNotSame(first, faces.forSession("s-2"), "two sessions never share a face");
    }

    @Test
    void nothingIsSpawnedUntilTheFirstVerb(@TempDir Path base) {
        FakeEngines engines = new FakeEngines();
        HeadlessBrowserFaces faces = directory(base, engines);
        faces.forSession("s-1");
        assertTrue(engines.opened.isEmpty(),
                "a session that never calls a browser tool never costs a Chrome process");
    }

    @Test
    void twoIdsThatSanitiseAlikeStillGetTwoProfiles(@TempDir Path base) {
        HeadlessBrowserFaces faces = directory(base, new FakeEngines());
        Path one = faces.profileDirFor("ab/c");
        Path two = faces.profileDirFor("ab:c");
        assertNotEquals(one, two,
                "sanitising is lossy and two sessions on one profile is the exact "
                        + "failure card 218 exists to prevent");
        assertTrue(one.startsWith(base), "profiles live under the directory's own base");
    }

    @Test
    void closingASessionKillsItsEngineAndTheNextOpeningGetsAFreshProfile(@TempDir Path base) {
        FakeEngines engines = new FakeEngines();
        HeadlessBrowserFaces faces = directory(base, engines);
        Path firstProfile = faces.profileDirFor("s-1");
        // Boot the engine by asking the face for a verb (the fake CDP answers).
        faces.forSession("s-1").send("navigate",
                new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode()
                        .put("url", "http://dev.example.com/"));
        assertEquals(1, engines.opened.size());

        faces.closeSession("s-1");
        waitUntil(() -> engines.killed.size() == 1, "the close must kill the engine");

        Path secondProfile = faces.profileDirFor("s-1");
        assertNotEquals(firstProfile, secondProfile,
                "a resumed session gets a fresh browser with a fresh profile, "
                        + "never the cookies of a run that ended");
        assertNotSame(faces.forSession("s-1"), null);
    }

    @Test
    void closingASessionThatNeverOpenedCostsNothing(@TempDir Path base) {
        FakeEngines engines = new FakeEngines();
        HeadlessBrowserFaces faces = directory(base, engines);
        faces.closeSession("never-seen");
        assertTrue(engines.killed.isEmpty());
    }

    @Test
    void closeAllKillsEveryOpenEngine(@TempDir Path base) {
        FakeEngines engines = new FakeEngines();
        HeadlessBrowserFaces faces = directory(base, engines);
        com.fasterxml.jackson.databind.node.ObjectNode url =
                new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode()
                        .put("url", "http://dev.example.com/");
        faces.forSession("s-1").send("navigate", url);
        faces.forSession("s-2").send("navigate", url);
        faces.closeAllSessions();
        waitUntil(() -> engines.killed.size() == 2,
                "a desktop shell attaching (or a shutdown) must leave no orphan Chrome");
    }

    @Test
    void attachedMeansAnEngineCanBeOpened(@TempDir Path base) {
        assertTrue(directory(base, new FakeEngines()).attached());
        HeadlessBrowserFaces without = new HeadlessBrowserFaces(Optional::empty, base,
                url -> null, new FakeEngines());
        assertFalse(without.attached(),
                "no Chrome on the machine means no web-face browser, said rather than hung");
        assertFalse(without.forSession("s-1").attached(),
                "the face a chromeless machine hands out must answer detached");
    }

    @Test
    void aFailedSpawnAnswersASentenceNotAnExceptionAndTheNextCallRetries(@TempDir Path base) {
        List<String> attempts = new ArrayList<>();
        HeadlessBrowserFaces faces = new HeadlessBrowserFaces(
                () -> Optional.of(Path.of("/usr/bin/true")), base, url -> null,
                (sessionId, profileDir) -> {
                    attempts.add(sessionId);
                    if (attempts.size() == 1) {
                        throw new IllegalStateException("Chrome exited before DevTools was up");
                    }
                    return new HeadlessBrowserFaces.Engine() {
                        @Override
                        public HeadlessBrowserFace.Cdp cdp() {
                            return new HeadlessBrowserFaceTest.FakeCdp();
                        }

                        @Override
                        public void kill() {
                        }
                    };
                });
        com.fasterxml.jackson.databind.node.ObjectNode url =
                new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode()
                        .put("url", "http://dev.example.com/");
        BrowserFace.Reply first = faces.forSession("s-1").send("navigate", url);
        assertFalse(first.ok());
        assertTrue(first.error().contains("Chrome exited"), first.error());
        BrowserFace.Reply second = faces.forSession("s-1").send("navigate", url);
        assertTrue(second.ok(), "a failed spawn must not poison the session's browser forever: "
                + second.error());
    }

    private static void waitUntil(java.util.function.BooleanSupplier condition, String what) {
        long deadline = System.currentTimeMillis() + 5_000;
        while (!condition.getAsBoolean() && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(10);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        assertTrue(condition.getAsBoolean(), what);
    }
}
