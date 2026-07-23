package dev.spectroscope.server.starter;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Ready-made starter projects embedded in the server so a newcomer goes from
 * zero to a running agent with almost no effort — pick a bundle, pick a build
 * tool, and either copy-paste the files or scaffold them into a folder.
 *
 * <p>Everything here is a pure function of (bundle id, build tool): the same
 * inputs render the same bytes, so it is trivially testable and is the single
 * source of truth the on-disk {@code samples/} set (card 29) can also render
 * from. No filesystem, no network — the {@link BundleController} does the I/O.
 *
 * <p>Build tools: Gradle and Maven, the two dominant JVM build tools. sbt is
 * intentionally deferred (it is Scala-first and rare for a Java library
 * consumer); adding it is one more branch in {@link #files}.
 */
public final class StarterBundles {

    /** The published Maven Central coordinates the bundles depend on. */
    public static final String GROUP = "dev.spectroscope";
    public static final String VERSION = "0.2.0";

    /** The editions a bundle can be rendered for: the two JVM build tools, the
     *  Python edition, and plain bash driving the CLI. */
    public enum BuildTool {
        GRADLE, MAVEN, PYTHON, BASH;

        /** Case-insensitive parse; defaults to GRADLE for an unknown/blank value. */
        public static BuildTool of(String raw) {
            if (raw == null) {
                return GRADLE;
            }
            return switch (raw.trim().toLowerCase()) {
                case "maven", "mvn", "pom" -> MAVEN;
                case "python", "py" -> PYTHON;
                case "bash", "sh", "shell" -> BASH;
                default -> GRADLE;
            };
        }
    }

    /** One starter project: its identity plus the single Java file it ships. */
    public record Bundle(String id, String name, String description,
                         String artifact, String mainClass, boolean fleet, String source) {
        /** The relative path of the Java file, from the package + class name. */
        public String sourcePath() {
            String pkg = mainClass.substring(0, mainClass.lastIndexOf('.'));
            String cls = mainClass.substring(mainClass.lastIndexOf('.') + 1);
            return "src/main/java/" + pkg.replace('.', '/') + "/" + cls + ".java";
        }
    }

    private static final List<Bundle> BUNDLES = List.of(
            new Bundle(
                    "five-lines",
                    "Five lines — a single agent",
                    "One agent, the frozen facade, the event stream printed to stdout.",
                    "spectroscope-five-lines",
                    "demo.FiveLines",
                    false,
                    """
                    package demo;

                    import java.nio.file.Path;

                    import dev.spectroscope.Spectro;
                    import dev.spectroscope.Anthropic;
                    import dev.spectroscope.Tools;
                    import dev.spectroscope.core.events.RunEvent;

                    /** The five lines: configure an agent, run it, watch the stream. */
                    public final class FiveLines {
                        public static void main(String[] args) {
                            var agent = Spectro.agent()
                                    .model(Anthropic.opus())
                                    .tools(Tools.readFile(), Tools.writeFile(), Tools.runCommand())
                                    .workspace(Path.of("/tmp/scratch"));

                            for (RunEvent event : agent.run("Write hello.txt with a greeting, then read it back")) {
                                System.out.println(event);   // the stream IS the observability
                            }
                        }
                    }
                    """),
            new Bundle(
                    "fleet",
                    "Fleet — a review swarm",
                    "Three agents review a diff in parallel; one merged spectrum on stdout.",
                    "spectroscope-fleet",
                    "demo.Fleet",
                    true,
                    """
                    package demo;

                    import dev.spectroscope.Spectro;
                    import dev.spectroscope.Anthropic;
                    import dev.spectroscope.core.events.RunEvent;

                    /** A fleet: three lanes, each an agent, one merged event stream. */
                    public final class Fleet {
                        public static void main(String[] args) {
                            var panel = Spectro.panel().model(Anthropic.opus());
                            panel.agent("bugs").task("Find bugs in the diff");
                            panel.agent("perf").task("Check the hot queries");
                            panel.agent("security").task("Look for injection and secrets");

                            for (RunEvent event : panel.run()) {
                                System.out.println(event);   // every lane, one spectrum
                            }
                        }
                    }
                    """),
            new Bundle(
                    "multi-agent",
                    "Multi-agent — a team that builds together",
                    "Heterogeneous lanes (a fast triage agent + deep workers) share a workspace and each write a slice.",
                    "spectroscope-multi-agent",
                    "demo.Team",
                    true,
                    """
                    package demo;

                    import java.nio.file.Path;

                    import dev.spectroscope.Spectro;
                    import dev.spectroscope.Anthropic;
                    import dev.spectroscope.Tools;
                    import dev.spectroscope.core.events.RunEvent;

                    /** A small team: a fast triage lane and two deep workers, one shared
                     *  workspace, each producing a slice of a release. */
                    public final class Team {
                        public static void main(String[] args) {
                            var panel = Spectro.panel()
                                    .model(Anthropic.opus())
                                    .workspace(Path.of("/tmp/release"));

                            // A cheap, fast lane triages; it has no write tools.
                            panel.agent("triage")
                                    .model(Anthropic.haiku())
                                    .task("List the release tasks, shortest first");

                            // Two deep lanes each own a slice and can write files.
                            panel.agent("notes")
                                    .tools(Tools.writeFile())
                                    .task("Write RELEASE_NOTES.md summarizing the changes");
                            panel.agent("docs")
                                    .tools(Tools.writeFile())
                                    .task("Write a short README.md for new users");

                            for (RunEvent event : panel.run()) {
                                System.out.println(event);   // every lane, one spectrum
                            }
                        }
                    }
                    """));

    private StarterBundles() {
    }

    /** All bundles, in listing order. */
    public static List<Bundle> list() {
        return BUNDLES;
    }

    /** The bundle with this id, or null when unknown. */
    public static Bundle byId(String id) {
        return BUNDLES.stream().filter(b -> b.id().equals(id)).findFirst().orElse(null);
    }

    /**
     * The complete set of files for a bundle rendered for a build tool, as
     * {relative path -> content}. Insertion order is stable (build file first,
     * then the source), so a copy-paste block reads top to bottom.
     *
     * @param id   the bundle id
     * @param tool the build tool to render for
     * @return the file map, or null when the id is unknown
     */
    public static Map<String, String> files(String id, BuildTool tool) {
        Bundle bundle = byId(id);
        if (bundle == null) {
            return null;
        }
        Map<String, String> out = new LinkedHashMap<>();
        switch (tool) {
            case MAVEN -> {
                out.put("pom.xml", pom(bundle));
                out.put(bundle.sourcePath(), bundle.source());
            }
            case PYTHON -> {
                // The Python edition is pre-release (no PyPI artifact yet), so the
                // README carries the honest install path instead of a requirements
                // line that could not install. The code is the REAL Python facade
                // (kwargs sugar, bare tool factories) — never a Java transliteration.
                out.put("README.md", pythonReadme(bundle));
                out.put("main.py", pythonSource(bundle));
            }
            case BASH -> {
                out.put("README.md", bashReadme(bundle));
                out.put("run.sh", bashSource(bundle));
            }
            default -> {
                out.put("settings.gradle.kts", "rootProject.name = \"" + bundle.artifact() + "\"\n");
                out.put("build.gradle.kts", gradleBuild(bundle));
                out.put(bundle.sourcePath(), bundle.source());
            }
        }
        return out;
    }

    // ---- the Python edition (pre-release; honest fan-out via spawn_agents) ----

    private static String pythonReadme(Bundle bundle) {
        return """
                # %s (Python)

                Needs the spectroscope **Python edition** — pre-release, not on PyPI
                yet: install it as a local package (`pip install -e spectro/` inside
                the edition's checkout; the public repository opens with its release).
                Set `ANTHROPIC_API_KEY`, or point the config at Ollama / any
                OpenAI-compatible server. Then: `python main.py`.
                """.formatted(bundle.name());
    }

    private static String pythonSource(Bundle bundle) {
        return switch (bundle.id()) {
            case "fleet" -> """
                    from spectroscope import Spectro, Anthropic, Tools

                    # A review fan-out, the Python way: the agent spawns subagents via the
                    # spawn_agents tool (sequential, depth 1). The Java edition's fleet-
                    # panel API does not exist here — this is the honest equivalent, one
                    # stream carrying every agent's events.
                    agent = Spectro.agent(
                        model=Anthropic.opus(),
                        tools=[Tools.read_file, Tools.spawn_agents],
                        workspace="/tmp/review",
                    )

                    PROMPT = (
                        "Review the diff in changes.patch with three parallel reviewers: "
                        "one for bugs, one for performance, one for security. "
                        "Spawn them with spawn_agents, then summarize by priority."
                    )

                    for event in agent.run(PROMPT):
                        print(event)   # every agent, one stream
                    """;
            case "multi-agent" -> """
                    from spectroscope import Spectro, Anthropic, Tools

                    # A small team, the Python way: workers spawned via spawn_agents share
                    # the workspace and each write a slice. (No fleet-panel API in the
                    # Python edition — subagent fan-out is the honest team story.)
                    agent = Spectro.agent(
                        model=Anthropic.opus(),
                        tools=[Tools.read_file, Tools.write_file, Tools.spawn_agents],
                        workspace="/tmp/release",
                    )

                    PROMPT = (
                        "Prepare the release: spawn one worker to write RELEASE_NOTES.md "
                        "summarizing the changes and one to write a short README.md for "
                        "new users, then merge their results into a checklist."
                    )

                    for event in agent.run(PROMPT):
                        print(event)   # every agent, one stream
                    """;
            default -> """
                    from spectroscope import Spectro, Anthropic, Tools

                    # The five lines, Python edition: one call, tools as bare names.
                    agent = Spectro.agent(
                        model=Anthropic.opus(),
                        tools=[Tools.read_file, Tools.write_file, Tools.run_command],
                        workspace="/tmp/scratch",
                    )

                    for event in agent.run("Write hello.txt with a greeting, then read it back"):
                        print(event)   # the stream IS the observability
                    """;
        };
    }

    // ---- bash: driving the real CLI (spectro run / spectro node) -------------

    private static String bashReadme(Bundle bundle) {
        String extra = bundle.fleet()
                ? """

                  The fleet variant needs a running hub: start the cockpit with
                  `SPECTRO_HUB_PORT=7700` and the nodes join it over loopback —
                  watch them under the sidebar's `fleets` segment.
                  """
                : "";
        return """
                # %s (bash)

                Drives the spectroscope CLI — `./spectro` from the release zip (or the
                repo checkout) on your PATH, a provider configured (`ANTHROPIC_API_KEY`
                or a local Ollama). Then: `chmod +x run.sh && ./run.sh`.
                %s""".formatted(bundle.name(), extra);
    }

    private static String bashSource(Bundle bundle) {
        return switch (bundle.id()) {
            case "fleet" -> """
                    #!/usr/bin/env bash
                    # A review swarm as PROCESSES: three spectro nodes, one hub, one fleet.
                    # Start the cockpit first: SPECTRO_HUB_PORT=7700 spectro web
                    set -euo pipefail

                    HUB="${SPECTRO_HUB:-127.0.0.1:7700}"
                    CONTEXT="pr-review"

                    spectro node -p "Find bugs in the diff"              --hub "$HUB" --context "$CONTEXT" --role bugs     --id bugs-1 &
                    spectro node -p "Check the hot queries"              --hub "$HUB" --context "$CONTEXT" --role perf     --id perf-1 &
                    spectro node -p "Look for injection and secrets"     --hub "$HUB" --context "$CONTEXT" --role security --id security-1 &

                    wait   # every node publishes its whole stream to the hub as it runs
                    echo "fleet $CONTEXT done — enter it in the cockpit's fleets sidebar"
                    """;
            case "multi-agent" -> """
                    #!/usr/bin/env bash
                    # A small team as processes: two writers share a workspace over one
                    # fleet context; ask-mode parks their write gates in the cockpit for
                    # you to answer (the gate bar) instead of a fixed yes or no.
                    # Start the cockpit first: SPECTRO_HUB_PORT=7700 spectro web
                    set -euo pipefail

                    HUB="${SPECTRO_HUB:-127.0.0.1:7700}"
                    CONTEXT="release"

                    spectro node -p "Write RELEASE_NOTES.md summarizing the changes" \\
                        --hub "$HUB" --context "$CONTEXT" --role notes --id notes-1 --permissions ask &
                    spectro node -p "Write a short README.md for new users" \\
                        --hub "$HUB" --context "$CONTEXT" --role docs --id docs-1 --permissions ask &

                    wait
                    echo "team $CONTEXT done — the cockpit's fleet views have the whole story"
                    """;
            default -> """
                    #!/usr/bin/env bash
                    # The five lines as one line: a headless run, the event stream on stdout.
                    set -euo pipefail

                    spectro run -p "Write hello.txt with a greeting, then read it back"
                    """;
        };
    }

    private static String deps(Bundle bundle, String coreLine, String orchLine) {
        String core = coreLine.replace("{V}", VERSION);
        if (!bundle.fleet()) {
            return core;
        }
        return core + "\n" + orchLine.replace("{V}", VERSION);
    }

    private static String gradleBuild(Bundle bundle) {
        String deps = deps(bundle,
                "    implementation(\"" + GROUP + ":spectro-core:{V}\")",
                "    implementation(\"" + GROUP + ":spectro-orchestrator:{V}\")");
        return """
                plugins {
                    application
                }

                repositories {
                    mavenCentral()
                }

                dependencies {
                %s
                }

                java {
                    toolchain {
                        languageVersion.set(JavaLanguageVersion.of(21))
                    }
                }

                application {
                    mainClass.set("%s")
                }
                """.formatted(deps, bundle.mainClass());
    }

    private static String pom(Bundle bundle) {
        String deps = deps(bundle,
                "    <dependency>\n"
                        + "      <groupId>" + GROUP + "</groupId>\n"
                        + "      <artifactId>spectro-core</artifactId>\n"
                        + "      <version>{V}</version>\n"
                        + "    </dependency>",
                "    <dependency>\n"
                        + "      <groupId>" + GROUP + "</groupId>\n"
                        + "      <artifactId>spectro-orchestrator</artifactId>\n"
                        + "      <version>{V}</version>\n"
                        + "    </dependency>");
        return """
                <?xml version="1.0" encoding="UTF-8"?>
                <project xmlns="http://maven.apache.org/POM/4.0.0"
                         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
                  <modelVersion>4.0.0</modelVersion>

                  <groupId>com.example</groupId>
                  <artifactId>%s</artifactId>
                  <version>0.1.0</version>

                  <properties>
                    <maven.compiler.release>21</maven.compiler.release>
                    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
                  </properties>

                  <dependencies>
                %s
                  </dependencies>

                  <build>
                    <plugins>
                      <plugin>
                        <groupId>org.codehaus.mojo</groupId>
                        <artifactId>exec-maven-plugin</artifactId>
                        <version>3.1.0</version>
                        <configuration>
                          <mainClass>%s</mainClass>
                        </configuration>
                      </plugin>
                    </plugins>
                  </build>
                </project>
                """.formatted(bundle.artifact(), deps, bundle.mainClass());
    }
}
