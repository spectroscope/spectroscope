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

    /** The build tools a bundle can be rendered for. */
    public enum BuildTool {
        GRADLE, MAVEN;

        /** Case-insensitive parse; defaults to GRADLE for an unknown/blank value. */
        public static BuildTool of(String raw) {
            if (raw == null) {
                return GRADLE;
            }
            return switch (raw.trim().toLowerCase()) {
                case "maven", "mvn", "pom" -> MAVEN;
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
        if (tool == BuildTool.MAVEN) {
            out.put("pom.xml", pom(bundle));
        } else {
            out.put("settings.gradle.kts", "rootProject.name = \"" + bundle.artifact() + "\"\n");
            out.put("build.gradle.kts", gradleBuild(bundle));
        }
        out.put(bundle.sourcePath(), bundle.source());
        return out;
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
