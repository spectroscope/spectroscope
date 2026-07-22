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
version = "0.1.0"

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
    sourceCompatibility = JavaVersion.VERSION_21
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
