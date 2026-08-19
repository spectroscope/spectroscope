// spectro-cli — the terminal face of the harness: a pure RunEvent renderer,
// plus the full-build extras (slash commands, allowlist, doctor).
// Run with: ./gradlew :spectro-cli:run -q --console=plain

plugins {
    application
}

group = "dev.spectroscope"
version = "0.10.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation(project(":spectro-core"))
    // The fleet node: `spectroscope node` publishes a headless run over the
    // ProcessBus. Clean DAG: cli -> orchestrator -> core.
    implementation(project(":spectro-orchestrator"))
    implementation(libs.picocli)
    // Logging night: Logback replaces the old slf4j-nop void — the shared
    // logback.xml keeps the console WARN-quiet (the ANSI face stays pristine)
    // and writes diagnostics to ~/.spectro/logs/spectroscope.log. LogSetup (level
    // apply) lives here too, shared with spectro-server.
    implementation(libs.logback.classic)

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
    // user.home is redirected by the ROOT subprojects block (card 235) — the
    // Transcriber and PiperSpeechEngine model paths depend on it too.
}

application {
    mainClass = "dev.spectroscope.cli.SpectroCli"
    applicationName = "spectro"
    // Heap: baked into DEFAULT_JVM_OPTS of the generated start scripts, so the
    // CLI zip in every release carries it without the user knowing. A third of
    // the machine rather than the JVM's 25%, and a share rather than a literal
    // so the same zip suits a workstation and a laptop. The number is
    // HeapBudget.MAX_RAM_PERCENT; HeapFlagDriftTest holds this file to it.
    applicationDefaultJvmArgs = listOf("-XX:MaxRAMPercentage=33")
}

tasks.named<JavaExec>("run") {
    // The REPL owns stdin — wire the Gradle task through to the terminal.
    standardInput = System.`in`
}

// The interactive stage tour: menu, guided tips, settings (hidden key input,
// local-provider switch). Working dir = the solution root, so the demos'
// path sandbox and the server-jar lookup see the whole project.
tasks.register<JavaExec>("tour") {
    group = "spectroscope"
    description = "Interactive stage tour — pick actions from a menu, set the key hidden."
    mainClass = "dev.spectroscope.cli.Tour"
    classpath = sourceSets.main.get().runtimeClasspath
    standardInput = System.`in`
    workingDir = rootProject.projectDir
}

// Load ANTHROPIC_API_KEY & friends from a local .env file (gitignored), so no
// shell export is needed: every JavaExec task (run*, tour, bootRun) inherits it.
val dotEnv: Map<String, String> = rootProject.file(".env").takeIf { it.isFile }
    ?.readLines()
    ?.map { it.trim() }
    ?.filter { it.isNotEmpty() && !it.startsWith("#") && it.contains("=") }
    ?.associate { line ->
        val parts = line.split("=", limit = 2)
        val raw = parts[1].trim()
        // A quoted value is taken verbatim; an unquoted one drops an inline
        // comment (KEY=value  # note) — otherwise the comment would ride into
        // the child env and, say, poison a Bearer header.
        val value = if (raw.length >= 2 && raw.startsWith("\"") && raw.endsWith("\""))
            raw.removeSurrounding("\"")
        else
            raw.split(Regex("\\s+#"), limit = 2)[0].trim()
        parts[0].trim() to value
    }
    ?.filterValues { it.isNotBlank() }   // `KEY=` lines stay OUT of the child env
    ?: emptyMap()

tasks.withType<JavaExec>().configureEach {
    dotEnv.forEach { (key, value) -> environment(key, value) }
    // Run from the spectroscope root, not the module dir, so SpectroConfig's project layer
    // resolves <root>/.spectro/settings.json — autoApprove, hooks, mcpServers.
    workingDir = rootProject.projectDir
}
