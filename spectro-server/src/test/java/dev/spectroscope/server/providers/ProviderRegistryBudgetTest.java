package dev.spectroscope.server.providers;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** A check answers within its budget whatever the provider does. */
class ProviderRegistryBudgetTest {

    /** Card 480 acceptance 2, as a literal so a raised constant cannot raise the bound with it. */
    private static final long CARD_CEILING_MS = 5_000L;

    /** The two files of the user layer, in the test home every test class of this module shares. */
    private static final List<Path> USER_LAYER =
            List.of(SpectroConfig.CONFIG_PATH, SpectroConfig.USER_SETTINGS_PATH);

    /** Holds the shared user layer while a test runs, so this class reads an empty one. */
    @TempDir
    Path stash;

    @BeforeEach
    void setTheSharedUserLayerAside() throws IOException {
        for (Path file : USER_LAYER) {
            if (Files.exists(file)) {
                Files.move(file, stash.resolve(file.getFileName()));
            }
        }
    }

    @AfterEach
    void putTheSharedUserLayerBack() throws IOException {
        for (Path file : USER_LAYER) {
            Path kept = stash.resolve(file.getFileName());
            if (Files.exists(kept)) {
                Files.move(kept, file, StandardCopyOption.REPLACE_EXISTING);
            }
        }
    }

    private static SpectroConfig config() {
        return SpectroConfig.load(SpectroConfig.Overrides.none());
    }

    @Test
    @Timeout(value = 20, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
    void aListerThatNeverReturnsIsATimeoutWithinTheBudget() throws InterruptedException {
        CountDownLatch never = new CountDownLatch(1);
        ProviderRegistry registry = new ProviderRegistry((p, c) -> {
            try {
                never.await();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return ListResult.ok(List.of(), "http://127.0.0.1:1");
        }, System::currentTimeMillis);
        long started = System.nanoTime();
        ProviderRow r = registry.check("ollama", config());
        long elapsedMs = (System.nanoTime() - started) / 1_000_000L;
        System.out.println("budget-test elapsed ms: " + elapsedMs);
        assertEquals("failed", r.state());
        assertEquals("timeout", r.reason());
        assertTrue(elapsedMs < CARD_CEILING_MS + 1_500L,
                "answered after " + elapsedMs + " ms, budget " + ProviderRegistry.CHECK_BUDGET_MS);
        never.countDown();
    }

    @Test
    @Timeout(value = 20, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
    void checkAllRunsTheSelectedProvidersSideBySideUnderOneBudget() {
        ProviderRegistry registry = new ProviderRegistry((p, c) -> {
            try {
                Thread.sleep(1_000L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return ListResult.ok(List.of(p + "-model"), "http://127.0.0.1:1");
        }, System::currentTimeMillis);
        long started = System.nanoTime();
        List<ProviderRow> rows = registry.checkAll(config(), r -> "local".equals(r.kind()));
        long elapsedMs = (System.nanoTime() - started) / 1_000_000L;
        System.out.println("checkAll-test elapsed ms: " + elapsedMs);
        long checked = rows.stream().filter(r -> "reachable".equals(r.state())).count();
        assertEquals(SpectroConfig.keylessLocalServers().size(), checked);
        assertTrue(elapsedMs < 3_000L, "three one second checks side by side took " + elapsedMs + " ms");
    }
}
