package dev.spectroscope.core.net;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * This repository is PUBLIC, so it must not name the machines of whoever
 * develops it.
 *
 * <p>The canon has said so in words since the test-backend section was written.
 * On 2026-08-13 it happened anyway: card 199's fence tests reached for real
 * addresses because real addresses were what proved the defect, and a tailnet
 * node, this machine's own tailnet address and a host on the home LAN were
 * merged and pushed. A rule that lives only in a document is checked by whoever
 * remembers it; this one is checked by the build.
 *
 * <p>The private RANGES are legitimate subjects here, since the net fence exists
 * to refuse them, so the guard does not ban them. It bans every address inside
 * them except a short list of stand-ins that belong to nobody: the first
 * addresses of the CGNAT block the tailnet rule names, and the documentation
 * hosts of the private blocks. A test that needs "an address in 100.64/10"
 * takes one of these; a test that reaches for the operator's own node turns
 * this red.
 */
class NoOperatorAddressesInTheRepoTest {

    /**
     * The addresses this repository is allowed to name, and the ONLY ones.
     *
     * <p>The point is not that these are safe by nature: a generic
     * {@code 192.168.1.10} and an operator's real {@code 192.168.50.154} look
     * identical to any regex. The point is that adding to this list is a
     * DELIBERATE act, visible in a diff, while reaching for the machine on your
     * desk is not. Every entry below was audited on 2026-08-13 and belongs to
     * nobody: documentation hosts, the first addresses of the ranges the fence
     * refuses, and the cloud metadata address the fence exists to block.
     *
     * <p>Adding one is fine. Adding one because a test needs to reach a real
     * host is the mistake this guard was written for; make it a parameter
     * instead, the way the SDK examples take theirs.
     */
    private static final Set<String> NEUTRAL = Set.of(
            // the CGNAT block a tailnet uses
            "100.64.0.0", "100.64.0.1", "100.64.0.2", "100.64.0.3",
            // RFC 1918, generic
            "10.0.0.1", "10.0.0.2", "10.0.0.5", "10.0.0.9",
            "172.16.0.1", "172.16.4.1", "172.16.4.4", "172.31.0.1",
            "192.168.0.1", "192.168.1.1", "192.168.1.5", "192.168.1.10", "192.168.1.50",
            // subjects of the fence rather than hosts
            "169.254.169.254", "127.0.0.1", "0.0.0.0", "255.255.255.255", "224.0.0.1",
            // RFC 5737 documentation
            "192.0.2.1", "198.51.100.1", "203.0.113.1");

    /** Every dotted quad, so the check reads them all and judges after. */
    private static final Pattern QUAD =
            Pattern.compile("\\b(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\b");

    @Test
    void noSourceFileNamesAMachineOnSomebodysPrivateNetwork() throws IOException {
        Path root = repoRoot();
        List<String> found = new ArrayList<>();
        try (Stream<Path> tree = Files.walk(root)) {
            tree.filter(Files::isRegularFile)
                .filter(NoOperatorAddressesInTheRepoTest::isSearchable)
                .forEach(file -> scan(root, file, found));
        }
        assertTrue(found.isEmpty(),
                "this repository is public and these lines name a machine on a private network.\n"
                        + "Use a stand-in that belongs to nobody, or make the address a parameter:\n  "
                        + String.join("\n  ", found));
    }

    private static void scan(Path root, Path file, List<String> found) {
        String text;
        try {
            text = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException notText) {
            return; // a binary that is not really UTF-8 has no addresses to leak
        }
        String[] lines = text.split("\n", -1);
        for (int i = 0; i < lines.length; i++) {
            Matcher m = QUAD.matcher(lines[i]);
            while (m.find()) {
                String address = m.group();
                if (NEUTRAL.contains(address) || !isPrivate(m)) {
                    continue;
                }
                found.add(root.relativize(file) + ":" + (i + 1) + "  " + address);
            }
        }
    }

    /** RFC 1918, the 100.64/10 range a tailnet uses, and link-local. */
    private static boolean isPrivate(Matcher quad) {
        int a = Integer.parseInt(quad.group(1));
        int b = Integer.parseInt(quad.group(2));
        if (a > 255 || b > 255 || Integer.parseInt(quad.group(3)) > 255
                || Integer.parseInt(quad.group(4)) > 255) {
            return false; // a version number or an offset, not an address
        }
        return a == 10
                || (a == 172 && b >= 16 && b <= 31)
                || (a == 192 && b == 168)
                || (a == 100 && b >= 64 && b <= 127)
                || (a == 169 && b == 254);
    }

    /** Text this repository ships or builds from, and nothing generated. */
    private static boolean isSearchable(Path file) {
        String name = file.getFileName().toString();
        String path = file.toString();
        if (path.contains("/build/") || path.contains("/node_modules/") || path.contains("/.git/")
                || path.contains("/dist/") || path.contains("/.gradle/")
                || path.contains("/static/assets/")) {
            return false;
        }
        // This guard names the ranges it guards, so it cannot police itself.
        if (name.equals("NoOperatorAddressesInTheRepoTest.java")) {
            return false;
        }
        return name.endsWith(".java") || name.endsWith(".ts") || name.endsWith(".tsx")
                || name.endsWith(".js") || name.endsWith(".md") || name.endsWith(".yml")
                || name.endsWith(".yaml") || name.endsWith(".json") || name.endsWith(".sh")
                || name.endsWith(".html") || name.endsWith(".css") || name.endsWith(".py");
    }

    private static Path repoRoot() {
        Path here = Path.of("").toAbsolutePath();
        while (here != null && !Files.exists(here.resolve("settings.gradle.kts"))) {
            here = here.getParent();
        }
        return here == null ? Path.of("").toAbsolutePath() : here;
    }
}
