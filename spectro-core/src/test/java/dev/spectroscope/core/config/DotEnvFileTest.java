package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 585, review D5 and N2: one reader and one writer for {@code ~/.spectro/.env}.
 * The file holds API keys, so a write never loses a line, even when two saves
 * arrive at once, and a crash never leaves it half written.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class DotEnvFileTest {

    @TempDir
    Path home;

    private static final String KEYS = "ANTHROPIC_API_KEY=sk-ant-FAKE-test-value-0001\n"
            + "OPENAI_API_KEY=\"quoted=with=equals\"\n"
            + "# a comment of mine\n";

    @Test
    void theReaderTakesTheLastLineVerbatim() throws Exception {
        Path f = home.resolve(".env");
        Files.writeString(f, "SPECTRO_HUB_PORT=1\n# SPECTRO_HUB_PORT=9\nSPECTRO_HUB_PORT=\"7745\"\n"
                + "ANTHROPIC_API_KEY=sk-secret\n SPECTRO_HUB_ENABLED = yes\n");
        Map<String, String> read = SpectroConfig.readDotEnv(f, List.of("SPECTRO_HUB_PORT", "SPECTRO_HUB_ENABLED"));
        assertEquals("\"7745\"", read.get("SPECTRO_HUB_PORT"), "last wins, quotes are kept");
        assertEquals(" yes", read.get("SPECTRO_HUB_ENABLED"), "the name is stripped, the value is verbatim");
        assertEquals(2, read.size(), "only the names asked for");
    }

    @Test
    void twoWritesAtOnceLoseNothing() throws Exception {
        Path f = home.resolve(".env");
        ExecutorService pool = Executors.newFixedThreadPool(2);
        int lost = 0;
        try {
            for (int round = 0; round < 300; round++) {
                Files.writeString(f, KEYS);
                CountDownLatch go = new CountDownLatch(1);
                int r = round;
                Future<?> a = pool.submit(() -> {
                    go.await();
                    SpectroConfig.writeEnvValue(f, "SPECTRO_HUB_ENABLED", r % 2 == 0 ? "true" : "false");
                    return null;
                });
                Future<?> b = pool.submit(() -> {
                    go.await();
                    SpectroConfig.writeEnvValue(f, "SPECTRO_HUB_PORT", String.valueOf(7700 + r % 50));
                    return null;
                });
                go.countDown();
                a.get();
                b.get();
                String text = Files.readString(f);
                if (!text.contains("ANTHROPIC_API_KEY=sk-ant-FAKE-test-value-0001")
                        || !text.contains("OPENAI_API_KEY=\"quoted=with=equals\"")
                        || !text.contains("SPECTRO_HUB_ENABLED=") || !text.contains("SPECTRO_HUB_PORT=")) {
                    lost++;
                }
            }
        } finally {
            pool.shutdownNow();
        }
        assertEquals(0, lost, "rounds that lost a key or one of the two settings");
    }

    @Test
    void aWriteReplacesTheNameInAnySpacingAndKeepsTheRest() throws Exception {
        Path f = home.resolve(".env");
        Files.writeString(f, KEYS + "SPECTRO_HUB_PORT = 1\n");
        SpectroConfig.writeEnvValue(f, "SPECTRO_HUB_PORT", "7745");
        assertEquals(List.of("ANTHROPIC_API_KEY=sk-ant-FAKE-test-value-0001", "OPENAI_API_KEY=\"quoted=with=equals\"",
                "# a comment of mine", "SPECTRO_HUB_PORT=7745"), Files.readAllLines(f));
    }

    @Test
    void theFileIsOwnerOnlyAndNoTempFileStaysBehind() throws Exception {
        Path f = home.resolve(".env");
        Files.writeString(f, KEYS);
        SpectroConfig.writeEnvValue(f, "SPECTRO_HUB_ENABLED", "true");
        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(f)));
        try (var listing = Files.list(home)) {
            assertEquals(List.of(".env"), listing.map(p -> p.getFileName().toString()).toList());
        }
    }

    @Test
    void aLinkedFileStaysALinkAndItsTargetGetsTheLine() throws Exception {
        Path real = home.resolve("real.env");
        Files.writeString(real, KEYS);
        Path link = Files.createSymbolicLink(home.resolve(".env"), real);
        SpectroConfig.writeEnvValue(link, "SPECTRO_HUB_ENABLED", "true");
        assertTrue(Files.isSymbolicLink(link), "the link is not replaced by a plain file");
        assertTrue(Files.readString(real).contains("SPECTRO_HUB_ENABLED=true"));
        assertTrue(Files.readString(real).contains("ANTHROPIC_API_KEY=sk-ant-FAKE-test-value-0001"));
    }
}
