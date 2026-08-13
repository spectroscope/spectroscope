package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The local build laboratory in {@code ci/} says the same things in four places:
 * the {@code STACKS} array in {@code ./spectro-env}, the compose file of each
 * stack, the port list {@code doctor} pre-flights, and the table in
 * {@code ci/README.md}. A stack added to one of them and missed in another
 * fails in a way nobody sees until they try it — {@code doctor} reports every
 * port free while one of them is occupied, or {@code up} names a folder that is
 * not there. Those four are read here and compared against each other.
 *
 * <p>Adding the search stack is what made this worth writing: it moved a port
 * list, a table, a count in an opening sentence and a count in a script header,
 * and nothing was watching any of them.</p>
 *
 * <p>The second half guards the seam between {@code ci/search} and
 * {@code samples/09-searxng}. They are deliberately two things — the sample
 * onboards a user and writes the address into the configuration, the stack just
 * runs an instance beside the other tools — but they run the same image and
 * turn on the same setting, so the facts they share are pinned rather than
 * remembered.</p>
 */
class CiStackDriftTest {

    static final Path CI = LangfuseComposeDriftTest.repoRoot().resolve("ci");
    /** The switch sits in the root and reads its stacks out of {@code ci/}; card 213 moved it there. */
    static final Path SWITCH = LangfuseComposeDriftTest.repoRoot().resolve("spectro-env");
    static final Path README = CI.resolve("README.md");

    /** One row of the {@code STACKS} array: name, folder, host port, url path, description. */
    record Stack(String name, String folder, int port, String path, String description) {}

    /**
     * The registry, read out of the shell array rather than restated here — a
     * copy of the list in this file would be one more place to forget.
     */
    static List<Stack> stacks() throws IOException {
        String script = Files.readString(SWITCH);
        String array = script.substring(script.indexOf("STACKS=("), script.indexOf(")\n\nstack_field"));
        List<Stack> stacks = new ArrayList<>();
        Matcher row = Pattern.compile("\"([^\"|]+)\\|([^\"|]+)\\|(\\d+)\\|([^\"|]+)\\|([^\"]+)\"").matcher(array);
        while (row.find()) {
            stacks.add(new Stack(row.group(1), row.group(2),
                    Integer.parseInt(row.group(3)), row.group(4), row.group(5)));
        }
        assertTrue(stacks.size() >= 5, "the STACKS array did not parse: " + array);
        return stacks;
    }

    @Test
    void everyRegisteredStackHasTheFolderItNames() throws IOException {
        List<String> missing = new ArrayList<>();
        for (Stack stack : stacks()) {
            if (!Files.exists(CI.resolve(stack.folder()).resolve("docker-compose.yml"))) {
                missing.add(stack.name() + " -> ci/" + stack.folder() + "/docker-compose.yml");
            }
        }
        // `up` only warns for a missing folder and moves on, so this is the
        // one place the mistake is loud.
        assertTrue(missing.isEmpty(), "registered but not on disk: " + missing);
    }

    @Test
    void everyStackPublishesThePortItIsRegisteredUnder() throws IOException {
        List<String> wrong = new ArrayList<>();
        for (Stack stack : stacks()) {
            if (stack.port() == 0) {
                continue; // renovate has no web face; the literal 0 means "no port"
            }
            String compose = Files.readString(CI.resolve(stack.folder()).resolve("docker-compose.yml"));
            // Either "8882:9000" or "127.0.0.1:8885:8080" — what matters is that
            // the HOST side is the port the switch prints and doctor checks.
            if (!Pattern.compile("[\"\\s:](" + stack.port() + "):\\d+\"").matcher(compose).find()) {
                wrong.add(stack.name() + " is registered on " + stack.port()
                        + " but ci/" + stack.folder() + "/docker-compose.yml does not publish it");
            }
        }
        assertTrue(wrong.isEmpty(), String.join("\n", wrong));
    }

    @Test
    void doctorPreflightsEveryPortAStackPublishes() throws IOException {
        // The failure this closes is quiet: doctor says "every port this needs
        // is free" while something else is sitting on the port the new stack
        // wants, and the stack then fails to bind for a reason doctor was
        // supposed to name.
        Matcher list = Pattern.compile("for p in ([0-9 ]+); do").matcher(Files.readString(SWITCH));
        assertTrue(list.find(), "doctor no longer pre-flights a port list; this test's premise is gone");
        List<String> preflight = List.of(list.group(1).trim().split("\\s+"));

        List<String> unchecked = new ArrayList<>();
        for (Stack stack : stacks()) {
            if (stack.port() != 0 && !preflight.contains(String.valueOf(stack.port()))) {
                unchecked.add(stack.name() + " (" + stack.port() + ")");
            }
        }
        assertTrue(unchecked.isEmpty(), "doctor checks " + preflight + " and misses: " + unchecked);
    }

    @Test
    void theReadmeTableNamesEveryStack() throws IOException {
        String readme = Files.readString(README);
        List<String> absent = new ArrayList<>();
        for (Stack stack : stacks()) {
            if (!readme.contains("| **" + stack.name() + "**")) {
                absent.add(stack.name());
            }
        }
        assertTrue(absent.isEmpty(), "ci/README.md's table does not list: " + absent);
    }

    @Test
    void theCountsInProseMatchTheNumberOfStacks() throws IOException {
        // "Five stacks, each a Docker Compose project" in the README and "one
        // command, five stacks" in the script header. A number written in words
        // is exactly the kind of thing that stays behind, and this repo has
        // paid for that before.
        Map<Integer, String> words = new LinkedHashMap<>();
        words.put(4, "four");
        words.put(5, "five");
        words.put(6, "six");
        words.put(7, "seven");
        words.put(8, "eight");
        words.put(9, "nine");

        int count = stacks().size();
        String expected = words.get(count);
        assertTrue(expected != null, "add " + count + " to the number words in this test");

        for (Path file : List.of(README, SWITCH)) {
            Matcher claim = Pattern.compile("(?i)\\b(four|five|six|seven|eight|nine) stacks\\b")
                    .matcher(Files.readString(file));
            assertTrue(claim.find(), "no \"<number> stacks\" sentence in " + file);
            assertEquals(expected, claim.group(1).toLowerCase(java.util.Locale.ROOT),
                    file.getFileName() + " says \"" + claim.group(1) + " stacks\" and there are " + count);
        }
    }

    @Test
    void theSearchStackAndTheSampleRunTheSameImage() throws IOException {
        // Two directories, one image. They diverge silently otherwise: the
        // sample gets a digest bump, the stack keeps a build from months ago,
        // and "it works in the sample" stops meaning anything.
        String stack = Files.readString(CI.resolve("search/docker-compose.yml"));
        String sample = Files.readString(
                LangfuseComposeDriftTest.repoRoot().resolve("samples/09-searxng/docker-compose.yml"));

        Pattern pinned = Pattern.compile("searxng/searxng@sha256:([0-9a-f]{64})");
        Matcher inStack = pinned.matcher(stack);
        Matcher inSample = pinned.matcher(sample);
        assertTrue(inStack.find(), "ci/search must pin searxng by digest; :latest moves every week");
        assertTrue(inSample.find(), "samples/09-searxng must pin searxng by digest");
        assertEquals(inSample.group(1), inStack.group(1),
                "ci/search and samples/09-searxng pin different searxng digests");
    }

    @Test
    void bringingTheSearchStackUpWritesItsSettingsFirst() throws IOException {
        // Compose alone starts a container that answers the browser and gives
        // an API client 403. The generator is what makes the difference, so
        // `up` has to run it — the same shape as Concourse's keypairs.
        String script = Files.readString(SWITCH);
        assertTrue(script.contains("search/generate-settings.sh"),
                "`up search` must generate the settings file before compose");
        assertTrue(Files.isExecutable(CI.resolve("search/generate-settings.sh")),
                "the generator must be executable");
    }

    @Test
    void theSearchStackNeverPublishesBeyondLoopback() throws IOException {
        // A metasearch proxy fetches attacker-influenced URLs for a living, and
        // this one exists for one reader on one machine.
        assertTrue(Files.readString(CI.resolve("search/docker-compose.yml")).contains("\"127.0.0.1:"),
                "the published port must bind loopback only");
    }

    @Test
    void theGeneratedSettingsTurnJsonOnAndCarryAKeyMadeHere(@TempDir Path work) throws Exception {
        // The property the whole folder exists for, run for real rather than
        // reviewed. The script writes next to itself, so a copy in a temp
        // directory keeps the repo out of it.
        Path script = work.resolve("generate-settings.sh");
        Files.copy(CI.resolve("search/generate-settings.sh"), script);
        assertTrue(script.toFile().setExecutable(true));

        Result first = run(work, List.of(script.toString()));
        assertEquals(0, first.exit(), first.output());

        Path settings = work.resolve("searxng/settings.yml");
        assertTrue(Files.exists(settings), "no settings file was written:\n" + first.output());
        String yaml = Files.readString(settings);
        assertTrue(yaml.lines().anyMatch(l -> l.strip().equals("- json")),
                "without json under search.formats the instance answers 403 to every API call:\n" + yaml);
        assertTrue(yaml.lines().anyMatch(l -> l.strip().equals("- html")),
                "html stays on: a human still has to be able to open the thing:\n" + yaml);

        String key = yaml.lines().filter(l -> l.strip().startsWith("secret_key:"))
                .findFirst().orElseThrow().replaceAll(".*secret_key:\\s*\"?([0-9a-f]+)\"?.*", "$1");
        assertEquals(64, key.length(), "32 bytes of hex generated on this machine, got: " + key);

        // Idempotent, and the key is the instance's identity: rotating it on a
        // re-run invalidates every preferences cookie it has handed out.
        Result again = run(work, List.of(script.toString()));
        assertEquals(0, again.exit(), again.output());
        assertEquals(yaml, Files.readString(settings), "a re-run must not rotate the instance's identity");
    }

    @Test
    void aSettingsFileWithoutJsonIsRefusedRatherThanReused(@TempDir Path work) throws Exception {
        // The realistic bad state: a settings.yml the image wrote itself, or one
        // edited since. Starting on it produces a browsable instance that answers
        // an API client 403 — the exact outcome this folder exists to prevent,
        // reached through the happy path.
        Path script = work.resolve("generate-settings.sh");
        Files.copy(CI.resolve("search/generate-settings.sh"), script);
        assertTrue(script.toFile().setExecutable(true));
        Files.createDirectories(work.resolve("searxng"));
        Files.writeString(work.resolve("searxng/settings.yml"), """
                use_default_settings: true
                server:
                  secret_key: "deadbeef"
                search:
                  formats:
                    - html
                """);

        Result refused = run(work, List.of(script.toString()));
        assertNotEquals(0, refused.exit(),
                "a settings file that cannot serve the API must not report success:\n" + refused.output());
        assertTrue(refused.output().contains("search.formats"),
                "the message must name the setting to add:\n" + refused.output());
    }

    @Test
    void noSecretAndNoPrivateAddressIsCommittedWithTheStack() throws IOException {
        // This repo is public. The settings file carries a generated key and is
        // gitignored; the ignore rule is the thing that has to hold.
        assertTrue(Files.readString(CI.resolve("search/.gitignore")).contains("searxng/"),
                "the generated settings directory must stay out of the repo");
        assertFalse(Files.exists(CI.resolve("search/searxng/settings.yml"))
                        && isTracked("ci/search/searxng/settings.yml"),
                "a generated settings file was committed");
    }

    private static boolean isTracked(String path) {
        try {
            return run(LangfuseComposeDriftTest.repoRoot(),
                    List.of("git", "ls-files", "--error-unmatch", path)).exit() == 0;
        } catch (Exception e) {
            return false; // no git here; the .gitignore assertion above still holds
        }
    }

    @Test
    void theScriptsParse() throws Exception {
        for (Path script : List.of(SWITCH, CI.resolve("search/generate-settings.sh"))) {
            Result parsed = run(CI, List.of("bash", "-n", script.toString()));
            assertEquals(0, parsed.exit(), "bash -n rejected " + script + ":\n" + parsed.output());
        }
    }

    /** One finished process: exit code plus its merged output. */
    record Result(int exit, String output) {}

    private static Result run(Path cwd, List<String> command) throws Exception {
        Process process = new ProcessBuilder(command).directory(cwd.toFile())
                .redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes());
        assertTrue(process.waitFor(60, TimeUnit.SECONDS), "the command hung:\n" + output);
        return new Result(process.exitValue(), output);
    }
}
