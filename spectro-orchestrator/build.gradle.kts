// spectro-orchestrator — the fleet: agents on a bus, task/status/result
// envelopes with correlation ids, every lane's events merged into ONE
// spectrum. A pure consumer of spectro-core (one core, many faces); the
// facade entry is Spectro.panel(), served through the FleetPanelFactory
// ServiceLoader hook so spectro-core never depends back on this module.

plugins {
    `java-library`
}

group = "dev.spectroscope"
version = "0.0.1"

repositories {
    mavenCentral()
}

dependencies {
    // The whole module speaks core types: RunEvent, EventStream, AgentOptions.
    api(project(":spectro-core"))

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
