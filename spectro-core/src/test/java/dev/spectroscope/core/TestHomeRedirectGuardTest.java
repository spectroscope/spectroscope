package dev.spectroscope.core;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

/**
 * Card 235: the test JVM never sees the operator's real home.
 *
 * <p>SessionStore and SpectroConfig resolve {@code ~/.spectro} from
 * {@code user.home} at class-load time. Between 2026-07-22 and 2026-08-14 the
 * modules WITHOUT a redirect wrote 180+ debris sessions into the real store
 * (CODE-REVIEW-2026-08-14, finding 5) — the count grew DURING the review.
 * The redirect now lives in ONE root {@code subprojects} block; this guard
 * exists in every module and turns red the moment that block stops reaching
 * its module.
 */
class TestHomeRedirectGuardTest {

    @Test
    void userHomePointsIntoTheBuildDirectoryNotTheRealHome() {
        Path userHome = Path.of(System.getProperty("user.home")).toAbsolutePath().normalize();
        Path expected = Path.of(System.getProperty("user.dir"), "build", "test-home")
                .toAbsolutePath().normalize();
        assertEquals(expected, userHome,
                "the root subprojects block must point user.home at build/test-home");

        String realHome = System.getenv("HOME");
        if (realHome != null && !realHome.isBlank()) {
            assertNotEquals(Path.of(realHome).toAbsolutePath().normalize(), userHome,
                    "the test JVM must never see the real home");
        }
    }
}
