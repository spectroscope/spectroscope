package dev.spectroscope.core.net;

import org.junit.jupiter.api.Test;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The net fence (card 199, criterion 5). Browser-class tools reach the network
 * on model output, and the model reads whatever the page says. On this machine
 * that reach includes the board on 8746, ollama on 11434 and a whole tailnet, so
 * the private ranges are refused by default and localhost costs an explicit
 * opt-in for the local verify loop.
 *
 * <p>DNS is a seam here: a name is checked by where it POINTS, not by how it
 * looks, because {@code localtest.me} looks public and resolves to 127.0.0.1.
 */
class NetFenceTest {

    /** A resolver that answers from a table — no DNS in the suite. */
    private static NetFence.Resolver table(Map<String, String> hostToAddress) {
        return host -> {
            String address = hostToAddress.get(host);
            if (address == null) {
                throw new UnknownHostException(host);
            }
            return List.of(InetAddress.getByName(address));
        };
    }

    private static NetFence fenced() {
        return new NetFence(false, table(Map.of(
                "example.com", "93.184.216.34",
                "localtest.me", "127.0.0.1",
                "board.internal", "192.168.1.10",
                "node.tailnet", "100.90.57.62")));
    }

    @Test
    void aPublicAddressPasses() {
        assertNull(fenced().refuse("https://example.com/docs"));
    }

    @Test
    void aFileUrlIsRefusedAndTheRefusalSaysSo() {
        NetFence.Refusal refusal = fenced().refuse("file:///Users/someone/.ssh/id_rsa");
        assertNotNull(refusal);
        assertEquals("file-url", refusal.rule());
        assertTrue(refusal.sentence().contains("file:// URL"), refusal.sentence());
        assertTrue(refusal.sentence().contains("rule: file-url"), refusal.sentence());
        assertFalse(refusal.sentence().contains("id_rsa"),
                "a refusal names the address and the rule and carries nothing else");
    }

    @Test
    void aSchemeThatIsNeitherHttpNorHttpsIsRefused() {
        assertEquals("non-http-scheme", fenced().refuse("ftp://example.com/x").rule());
        assertEquals("non-http-scheme", fenced().refuse("data:text/html,<script>").rule());
    }

    @Test
    void theRfc1918RangesAreRefusedByLiteralAndByName() {
        assertEquals("rfc1918", fenced().refuse("http://10.0.0.5/").rule());
        assertEquals("rfc1918", fenced().refuse("http://172.16.4.1/").rule());
        assertEquals("rfc1918", fenced().refuse("http://192.168.1.10:8746/").rule());
        assertEquals("rfc1918", fenced().refuse("http://board.internal:8746/graph").rule(),
                "a name that POINTS into the range is refused too");
    }

    @Test
    void theTailnetRangeIsRefused() {
        assertEquals("cgnat-tailnet", fenced().refuse("http://100.90.57.62:1234/v1/models").rule());
        assertEquals("cgnat-tailnet", fenced().refuse("http://node.tailnet:1234/").rule());
        assertNull(fenced().refuse("https://100.63.255.255/"), "100.63 is outside 100.64/10");
        assertNull(fenced().refuse("https://100.128.0.1/"), "and so is 100.128");
    }

    @Test
    void theLinkLocalMetadataAddressIsRefused() {
        assertEquals("link-local", fenced().refuse("http://169.254.169.254/latest/meta-data/").rule());
    }

    @Test
    void localhostIsRefusedUntilItIsOptedIntoByName() {
        assertEquals("loopback", fenced().refuse("http://localhost:8746/").rule());
        assertEquals("loopback", fenced().refuse("http://127.0.0.1:11434/api/tags").rule());
        assertEquals("loopback", fenced().refuse("http://[::1]:8746/").rule());
        assertEquals("loopback", fenced().refuse("http://localtest.me/").rule(),
                "a public-looking name that resolves to loopback is still loopback");
    }

    @Test
    void theVerifyLoopOptInReachesLoopbackAndNothingElse() {
        NetFence opted = new NetFence(true, table(Map.of(
                "board.internal", "192.168.1.10",
                "node.tailnet", "100.90.57.62")));
        assertNull(opted.refuse("http://localhost:8746/"));
        assertNull(opted.refuse("http://127.0.0.1:11434/api/tags"));
        assertEquals("rfc1918", opted.refuse("http://board.internal:8746/").rule(),
                "the opt-in is for the local verify loop, not for the LAN");
        assertEquals("cgnat-tailnet", opted.refuse("http://node.tailnet:1234/").rule(),
                "and not for the tailnet");
        assertEquals("file-url", opted.refuse("file:///etc/passwd").rule(),
                "and never for file urls");
    }

    @Test
    void theRefusalNamesTheHostAndThePortAndNeverThePathTheQueryOrACredential() {
        NetFence.Refusal refusal =
                fenced().refuse("http://user:hunter2@192.168.1.10:8746/x?token=sk-secret");
        assertEquals("rfc1918", refusal.rule());
        assertTrue(refusal.sentence().contains("192.168.1.10:8746"), refusal.sentence());
        assertFalse(refusal.sentence().contains("hunter2"), "no credential material");
        assertFalse(refusal.sentence().contains("sk-secret"), "no token from the query string");
        assertFalse(refusal.sentence().contains("/x"), "no path");
    }

    @Test
    void aNameNobodyCanResolveIsLeftToTheFetchToFail() {
        // The fence answers "where does this point"; when DNS cannot say, it does
        // not invent an answer. The request cannot connect either, so refusing
        // here would only make the fence a second DNS dependency.
        assertNull(fenced().refuse("https://nothing.invalid/"));
    }

    @Test
    void aUrlThatIsNotAUrlIsRefusedRatherThanGuessedAt() {
        assertEquals("unparsable", fenced().refuse("http://[not a host]/").rule());
        assertEquals("unparsable", fenced().refuse("").rule());
    }

    @Test
    void loopbackWrittenAsSomethingElseIsStillLoopback() {
        // 2130706433 is 127.0.0.1 as one integer; the fence judges addresses, not
        // spellings, so an alternative spelling must not slip past as a "name".
        NetFence fence = fenced();
        assertNotNull(fence.refuse("http://2130706433:8746/"),
                "the integer spelling of 127.0.0.1 is refused");
        assertNotNull(fence.refuse("http://[::ffff:10.0.0.1]/"),
                "and so is an IPv4-mapped private address");
    }

    @Test
    void aHostNameMadeOfHexLettersIsStillAName() {
        // beef.cafe is a real domain shape. It must reach the resolver seam and
        // not be mistaken for an address.
        NetFence fence = new NetFence(false,
                table(Map.of("beef.cafe", "10.0.0.9")));
        assertEquals("rfc1918", fence.refuse("https://beef.cafe/").rule());
    }
}
