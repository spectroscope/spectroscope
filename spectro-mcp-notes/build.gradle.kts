// spectro-mcp-notes — a tiny standalone MCP server (stdio JSON-RPC 2.0) that
// exposes full-text search over a directory of note files. Independent of
// spectro-core: it is a program a spectroscope MCP client spawns, not a library.
// The `application` plugin gives a runnable jar via installDist / run.

plugins {
    application
}

group = "dev.spectroscope"
version = "0.2.0"

repositories {
    mavenCentral()
}

dependencies {
    // Plain Jackson only — an MCP server is just a program that answers
    // tools/call over stdin/stdout. No heavy MCP SDK, no Lucene.
    implementation(libs.jackson.databind)

    testImplementation(libs.junit.jupiter)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

application {
    mainClass = "dev.spectroscope.mcp.notes.NotesServer"
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
    // The real-process integration test spawns the notes program as a child JVM.
    // Hand the test the exact runtime classpath and the main class so it can build
    // `java -cp <cp> spectroscope.mcp.notes.NotesServer` — no reliance on an install step.
    val runtimeCp = sourceSets["main"].runtimeClasspath
    dependsOn(runtimeCp)
    doFirst {
        systemProperty("spectroscope.notes.runtimeClasspath", runtimeCp.asPath)
        systemProperty("spectro.notes.mainClass", "dev.spectroscope.mcp.notes.NotesServer")
        systemProperty("spectroscope.notes.javaHome", System.getProperty("java.home"))
    }
}
