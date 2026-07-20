// spectro-cli — the terminal face of the harness: a pure RunEvent renderer,
// plus the full-build extras (slash commands, allowlist, doctor).
// Run with: ./gradlew :spectro-cli:run -q --console=plain

plugins {
    application
}

group = "dev.spectroscope"
version = "0.0.1"

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
    // Bonus 2/3: the Transcriber and PiperSpeechEngine resolve their default model
    // paths from user.home at class-load time; point it into the build directory so
    // a test never depends on the real ~/.spectro (no ffmpeg, whisper, piper needed).
    systemProperty("user.home", layout.buildDirectory.dir("test-home").get().asFile.absolutePath)
}

application {
    mainClass = "dev.spectroscope.cli.SpectroCli"
    applicationName = "spectro"
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
