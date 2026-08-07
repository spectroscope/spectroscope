// spectro-orchestrator — the fleet: agents on a bus, task/status/result
// envelopes with correlation ids, every lane's events merged into ONE
// spectrum. A pure consumer of spectro-core (one core, many faces); the
// facade entry is Spectro.panel(), served through the FleetPanelFactory
// ServiceLoader hook so spectro-core never depends back on this module.

plugins {
    `java-library`
    alias(libs.plugins.maven.central.publish)
}

group = "dev.spectroscope"
version = "0.7.0"

repositories {
    mavenCentral()
}

dependencies {
    // The whole module speaks core types: RunEvent, EventStream, AgentOptions.
    api(project(":spectro-core"))
    // Same discipline as the core (logging night): the module speaks the
    // slf4j API only — whoever embeds it picks the backend.
    implementation(libs.slf4j.api)

    testImplementation(libs.junit.jupiter)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

java {
    // A TOOLCHAIN, not just sourceCompatibility. The two answer different
    // questions, and only one of them was answered before.
    //
    // `options.release = 21` below already guarantees the ARTEFACT: it compiles
    // against Java 21's class library, so a post-21 API cannot slip into a jar
    // that Maven Central promises is "java 21+". Measured on this machine's
    // JDK 25 on 2026-08-06: class file major 65, which is Java 21.
    //
    // What it does NOT govern is which JVM RUNS the tests. On the developer's
    // Mac that was 25 while CI and the build container used 21, so the local
    // gate and the real gate were not the same gate — and this project has now
    // been bitten twice by exactly that shape of difference: a test that only
    // held on macOS, and six PTY tests that only ran outside a container.
    //
    // A toolchain closes it. Gradle resolves a Java 21 JDK for compiling AND
    // for the test JVM, and downloads one if the machine has none, so nobody
    // has to install a version manager for the build to be reproducible.
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

tasks.withType<JavaCompile>().configureEach {
    options.release = 21
    options.encoding = "UTF-8"
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("failed", "skipped")
    }
}

// Maven Central (card 23): publishes as dev.spectroscope:spectro-orchestrator
// next to spectro-core — same portal, same signing, same RELEASING.md.
mavenPublishing {
    publishToMavenCentral()
    signAllPublications()
    pom {
        name.set("spectro-orchestrator")
        description.set("The spectroscope fleet: agents on a bus, one merged spectrum — "
                + "BusEnvelope wire format, in-memory bus and a TCP ProcessBus with "
                + "reconnect, at-least-once delivery and a bounded replay ring.")
        url.set("https://spectroscope.dev")
        licenses {
            license {
                name.set("MIT License")
                url.set("https://github.com/spectroscope/spectroscope/blob/main/LICENSE")
            }
        }
        developers {
            developer {
                id.set("chris")
                name.set("Christopher Ezell")
                email.set("chris@spectroscope.ai")
            }
        }
        scm {
            url.set("https://github.com/spectroscope/spectroscope")
            connection.set("scm:git:git://github.com/spectroscope/spectroscope.git")
            developerConnection.set("scm:git:ssh://git@github.com/spectroscope/spectroscope.git")
        }
    }
}
