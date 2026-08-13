package dev.spectroscope.core.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.net.NetFence;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The Java half of the twin vector table.
 *
 * <p>Card 201 puts the same fence policy in two languages: {@link NetFence} in
 * Java judges the address a tool was handed, and {@code browserFence.ts} inside
 * the Electron request hook judges every redirect hop and every subresource.
 * Two implementations of one policy drift, and the drift is silent — the browser
 * would quietly allow what the tool refuses, or the reverse.
 *
 * <p>So both read {@code /browser/fence-vectors.json} and both are checked
 * against it. This test is one half; {@code spectro-desktop/src/browserFence.test.ts}
 * is the other, and it reads the same file off disk.
 *
 * <p>The table has two halves because the fence has two questions. The
 * {@code vectors} half is address literals and loopback names, which both sides
 * decide without a resolver. The {@code names} half writes the DNS answer DOWN,
 * so both sides can be driven by the same answer without a network: this side
 * through {@link NetFence.Resolver}, the hook through its own lookup seam.
 *
 * <p>The names half was added on 2026-08-13, after a review measured what its
 * absence cost. The hook skipped DNS entirely and the table's comment described
 * that as a documented split; it was a hole. With the loopback opt-in OFF, a 302
 * to a public name resolving to 127.0.0.1 loaded and refused nothing, while this
 * side refused the same address at the entry — so the table recorded no
 * disagreement, which is exactly the shape a twin table exists to catch.
 */
class FenceVectorTwinTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Public answers only: no vector in the table needs a name resolved. */
    private static final NetFence.Resolver DNS =
            host -> List.of(InetAddress.getByName("93.184.216.34"));

    private static JsonNode table() throws Exception {
        try (InputStream in = FenceVectorTwinTest.class
                .getResourceAsStream("/browser/fence-vectors.json")) {
            assertTrue(in != null, "the shared vector table must ship on the classpath");
            return JSON.readTree(in);
        }
    }

    private static JsonNode vectors() throws Exception {
        return table().path("vectors");
    }

    @Test
    void theJavaFenceAgreesWithEveryVectorInTheSharedTable() throws Exception {
        List<String> wrong = new ArrayList<>();
        for (JsonNode vector : vectors()) {
            String url = vector.path("url").asText();
            boolean allowLocalhost = vector.path("allowLocalhost").asBoolean();
            String expected = vector.path("rule").isNull() ? null : vector.path("rule").asText();
            NetFence.Refusal refusal = new NetFence(allowLocalhost, DNS).refuse(url);
            String actual = refusal == null ? null : refusal.rule();
            if (!java.util.Objects.equals(expected, actual)) {
                wrong.add("\"" + url + "\" allowLocalhost=" + allowLocalhost
                        + " expected " + expected + " but got " + actual);
            }
        }
        assertTrue(wrong.isEmpty(), "the shared fence policy disagrees with this side:\n  "
                + String.join("\n  ", wrong));
    }

    @Test
    void theTableIsNotEmptyAndCoversTheRulesThatMatter() throws Exception {
        List<String> rules = new ArrayList<>();
        for (JsonNode vector : vectors()) {
            if (!vector.path("rule").isNull()) {
                rules.add(vector.path("rule").asText());
            }
        }
        assertTrue(rules.size() >= 20, "a table this small proves nothing: " + rules.size());
        for (String required : List.of("file-url", "non-http-scheme", "loopback", "rfc1918",
                "cgnat-tailnet", "link-local", "unique-local", "unspecified", "multicast",
                "broadcast", "unparsable")) {
            assertTrue(rules.contains(required), "no vector covers the rule " + required);
        }
    }

    /**
     * The divergence register, asserted from this side.
     *
     * <p>Two parsers read an old IPv4 spelling differently, so the two halves of
     * the fence answer differently, and that is written down instead of wished
     * away. What this test pins is that JAVA still answers what the register
     * says it answers — if a JDK upgrade changes {@code InetAddress}, this goes
     * red and the register gets corrected rather than quietly becoming fiction.
     */
    @Test
    void theDivergenceRegisterStillDescribesThisSideCorrectly() throws Exception {
        JsonNode register = table().path("divergences");
        assertTrue(register.size() >= 2, "the register lost its rows");
        for (JsonNode row : register) {
            String url = row.path("url").asText();
            NetFence.Refusal refusal =
                    new NetFence(row.path("allowLocalhost").asBoolean(), DNS).refuse(url);
            String actual = refusal == null ? null : refusal.rule();
            String expected = row.path("java").isNull() ? null : row.path("java").asText();
            assertEquals(expected, actual,
                    "the register says Java answers " + expected + " for " + url);
            assertTrue(!row.path("hook").isNull(),
                    "a divergence row must say what the hook does with " + url);
        }
    }

    /** A resolver that answers from the table, so no vector needs the network. */
    private static NetFence.Resolver answering(List<String> addresses) {
        return host -> {
            List<InetAddress> resolved = new ArrayList<>();
            for (String address : addresses) {
                resolved.add(InetAddress.getByName(address));
            }
            return resolved;
        };
    }

    @Test
    void theJavaFenceAgreesWithEveryNameVectorInTheSharedTable() throws Exception {
        JsonNode names = table().path("names");
        assertTrue(names.size() >= 6, "the names half proves nothing this small: " + names.size());
        List<String> wrong = new ArrayList<>();
        for (JsonNode vector : names) {
            String url = vector.path("url").asText();
            List<String> answers = new ArrayList<>();
            vector.path("resolvesTo").forEach(node -> answers.add(node.asText()));
            boolean allowLocalhost = vector.path("allowLocalhost").asBoolean();
            String expected = vector.path("rule").isNull() ? null : vector.path("rule").asText();
            NetFence.Refusal refusal =
                    new NetFence(allowLocalhost, answering(answers)).refuse(url);
            String actual = refusal == null ? null : refusal.rule();
            if (!java.util.Objects.equals(expected, actual)) {
                wrong.add("\"" + url + "\" -> " + answers + " allowLocalhost=" + allowLocalhost
                        + " expected " + expected + " but got " + actual);
            }
        }
        assertTrue(wrong.isEmpty(), "the shared fence policy disagrees with this side on names:\n  "
                + String.join("\n  ", wrong));
    }

    @Test
    void oneAnswerAmongPublicOnesIsEnoughToRefuseTheName() {
        NetFence.Refusal refusal = new NetFence(true,
                answering(List.of("93.184.216.34", "10.0.0.5"))).refuse("http://split.example.com/");
        assertEquals("rfc1918", refusal.rule(),
                "a name with one private answer is refused, on both sides");
    }

    @Test
    void theTableCoversTheIpv4MappedSpellingThatWasAHookHole() throws Exception {
        // The measured bypass, now an ordinary vector because the two sides agree
        // again: [::ffff:192.168.1.1] reached the LAN through the hook with zero
        // refusals, while this side always read it as 192.168.1.1.
        List<String> mapped = new ArrayList<>();
        for (JsonNode vector : vectors()) {
            if (vector.path("url").asText().contains("::ffff:")
                    || vector.path("url").asText().contains("::FFFF:")) {
                mapped.add(vector.path("url").asText());
            }
        }
        assertTrue(mapped.size() >= 5, "the mapped spelling is barely covered: " + mapped);
        assertEquals("rfc1918",
                new NetFence(true, DNS).refuse("http://[::ffff:192.168.1.1]/secret").rule());
        assertEquals("rfc1918",
                new NetFence(true, DNS).refuse("http://[::ffff:c0a8:101]/secret").rule());
    }

    @Test
    void everyRefusalSentenceNamesTheAddressAndCarriesNoPathOrQuery() {
        NetFence fence = new NetFence(true, DNS);
        NetFence.Refusal refusal = fence.refuse("http://192.168.1.1/admin?token=SECRETVALUE");
        assertEquals("rfc1918", refusal.rule());
        assertTrue(refusal.sentence().contains("192.168.1.1"), refusal.sentence());
        assertTrue(!refusal.sentence().contains("SECRETVALUE"), refusal.sentence());
        assertTrue(!refusal.sentence().contains("/admin"), refusal.sentence());
    }
}
