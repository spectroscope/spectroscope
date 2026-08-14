package dev.spectroscope.core.browser.headless;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.net.NetFence;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The web face's half of the fence — the judge that stands where the desktop's
 * {@code browserFence.ts} request hook stands (card 226).
 *
 * <p>The desktop's in-hook fence and the Java entry check are twins over one
 * vector table. The web face adds a THIRD place the policy runs: the headless
 * engine's own navigation gate, judging every document hop Chrome reports. It
 * must be the same policy, so it reads the same table — a rule added to the
 * table and forgotten here turns this red, exactly as it would for the other
 * two.
 *
 * <p>What is deliberately different from the desktop hook: the URL this judge
 * receives comes out of Chrome's own network stack, WHATWG-normalised — the old
 * IPv4 spellings ({@code 0177.0.0.1}, {@code 0x7f000001}) arrive already
 * rewritten to {@code 127.0.0.1}, so the divergence register's rows cannot
 * reach it in their raw spelling. The vectors it CAN meet are the normalised
 * ones, and those are the rows asserted here.
 */
class HeadlessFenceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode table() throws Exception {
        try (InputStream in = HeadlessFenceTest.class
                .getResourceAsStream("/browser/fence-vectors.json")) {
            assertTrue(in != null, "the shared vector table must ship on the classpath");
            return JSON.readTree(in);
        }
    }

    /** Public answer for anything a vector row does not pin. */
    private static final NetFence.Resolver PUBLIC_DNS =
            host -> List.of(InetAddress.getByName("93.184.216.34"));

    @Test
    void theWebFaceJudgeAgreesWithEveryVectorInTheSharedTable() throws Exception {
        List<String> wrong = new ArrayList<>();
        for (JsonNode vector : table().path("vectors")) {
            String url = vector.path("url").asText();
            boolean allowLocalhost = vector.path("allowLocalhost").asBoolean();
            String expected = vector.path("rule").isNull() ? null : vector.path("rule").asText();
            HeadlessFence fence = new HeadlessFence(() -> allowLocalhost, PUBLIC_DNS,
                    System::currentTimeMillis, HeadlessFence.LOOKUP_TTL_MS);
            NetFence.Refusal refusal = fence.judge(url);
            String actual = refusal == null ? null : refusal.rule();
            if (!java.util.Objects.equals(expected, actual)) {
                wrong.add("\"" + url + "\" allowLocalhost=" + allowLocalhost
                        + " expected " + expected + " but got " + actual);
            }
        }
        assertTrue(wrong.isEmpty(), "the web face's judge disagrees with the shared table:\n  "
                + String.join("\n  ", wrong));
    }

    @Test
    void aHostNameIsJudgedByEveryAnswerItResolvesTo() throws Exception {
        List<String> wrong = new ArrayList<>();
        for (JsonNode name : table().path("names")) {
            String url = name.path("url").asText();
            boolean allowLocalhost = name.path("allowLocalhost").asBoolean();
            String expected = name.path("rule").isNull() ? null : name.path("rule").asText();
            List<InetAddress> answers = new ArrayList<>();
            for (JsonNode answer : name.path("resolvesTo")) {
                answers.add(InetAddress.getByName(answer.asText()));
            }
            HeadlessFence fence = new HeadlessFence(() -> allowLocalhost, host -> answers,
                    System::currentTimeMillis, HeadlessFence.LOOKUP_TTL_MS);
            NetFence.Refusal refusal = fence.judge(url);
            String actual = refusal == null ? null : refusal.rule();
            if (!java.util.Objects.equals(expected, actual)) {
                wrong.add("\"" + url + "\" expected " + expected + " but got " + actual);
            }
        }
        assertTrue(wrong.isEmpty(), "the names half disagrees:\n  " + String.join("\n  ", wrong));
    }

    @Test
    void aResolvedAnswerIsReusedInsideTheWindowAndReaskedAfterIt() {
        AtomicInteger lookups = new AtomicInteger();
        AtomicLong clock = new AtomicLong(1_000_000);
        NetFence.Resolver counting = host -> {
            lookups.incrementAndGet();
            return List.of(InetAddress.getLoopbackAddress());
        };
        HeadlessFence fence = new HeadlessFence(() -> false, counting, clock::get, 30_000);

        assertNotNull(fence.judge("http://dev.example.com/"));
        assertNotNull(fence.judge("http://dev.example.com/other"));
        assertEquals(1, lookups.get(), "two judgments inside the window must pay one lookup");

        clock.addAndGet(30_001);
        assertNotNull(fence.judge("http://dev.example.com/"));
        assertEquals(2, lookups.get(), "past the window the answer must be re-asked");
    }

    @Test
    void aFailedLookupIsNotRememberedForTheWholeWindow() {
        AtomicInteger lookups = new AtomicInteger();
        NetFence.Resolver flaky = host -> {
            if (lookups.incrementAndGet() == 1) {
                throw new java.net.UnknownHostException(host);
            }
            return List.of(InetAddress.getLoopbackAddress());
        };
        AtomicLong clock = new AtomicLong(0);
        HeadlessFence fence = new HeadlessFence(() -> false, flaky, clock::get, 30_000);

        // The fence invents nothing for a name DNS cannot answer — allowed through
        // to fail on its own, exactly the entry check's rule.
        assertNull(fence.judge("http://dev.example.com/"));
        // The second call must ASK again rather than reuse the failure, and this
        // time the answer is loopback and the judge refuses.
        assertNotNull(fence.judge("http://dev.example.com/"));
        assertEquals(2, lookups.get());
    }

    @Test
    void anAddressLiteralNeverPaysALookup() {
        AtomicInteger lookups = new AtomicInteger();
        NetFence.Resolver counting = host -> {
            lookups.incrementAndGet();
            return List.of(InetAddress.getByName("93.184.216.34"));
        };
        HeadlessFence fence = new HeadlessFence(() -> false, counting,
                System::currentTimeMillis, 30_000);
        assertNotNull(fence.judge("http://192.168.1.1/"));
        assertNull(fence.judge("http://93.184.216.34/"));
        assertEquals(0, lookups.get(), "a literal is already an answer");
    }

    @Test
    void theOptInIsReadPerJudgmentNotPerConstruction() {
        Map<String, Boolean> setting = new HashMap<>();
        setting.put("allowLocalhost", false);
        HeadlessFence fence = new HeadlessFence(() -> setting.get("allowLocalhost"),
                PUBLIC_DNS, System::currentTimeMillis, 30_000);
        assertNotNull(fence.judge("http://127.0.0.1:5173/"));
        setting.put("allowLocalhost", true);
        assertNull(fence.judge("http://127.0.0.1:5173/"),
                "a mid-session opt-in must reach the very next judgment");
    }
}
