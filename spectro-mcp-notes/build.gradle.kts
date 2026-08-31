// spectro-mcp-notes — a tiny standalone MCP server (stdio JSON-RPC 2.0) that
// exposes full-text search over a directory of note files. Independent of
// spectro-core: it is a program a spectroscope MCP client spawns, not a library.
// The `application` plugin gives a runnable jar via installDist / run.

plugins {
    application
}

group = "dev.spectroscope"
version = "0.11.0"

repositories {
    mavenCentral()
}

dependencies {
    // Plain Jackson only — an MCP server is just a program that answers
    // tools/call over stdin/stdout. No heavy MCP SDK, no Lucene.
    // The BOM travels with the artifact — see spectro-core for why it is a BOM
    // and not a number.
    implementation(platform(libs.jackson.bom))
    implementation(libs.jackson.databind)

    testImplementation(libs.junit.jupiter)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

application {
    mainClass = "dev.spectroscope.mcp.notes.NotesServer"
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
