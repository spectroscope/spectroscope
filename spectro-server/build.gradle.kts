// spectro-server — the second face: Spring Boot translates between the
// EventStream and the WebSocket, REST serves the session store, and the
// built React UI ships from src/main/resources/static (vite writes it there).
// Spring Boot appears ONLY in this module.

plugins {
    java
    id("org.springframework.boot") version "3.5.3"
}

group = "dev.spectroscope"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    // Boot's BOM pins every Spring version — no versions on the starters below.
    implementation(platform(org.springframework.boot.gradle.plugin.SpringBootPlugin.BOM_COORDINATES))
    implementation(project(":spectro-core"))
    // The fleet aggregator: the server hosts the ProcessBusHub (opt-in) and
    // folds the fleet for /api/fleet and the socket frames.
    implementation(project(":spectro-orchestrator"))
    // Bonus 2: the web /api/transcribe endpoint reuses the CLI's voice.Transcriber
    // (deliberate, pragmatic reuse — the audio channel lives in spectroscope.cli.voice, the
    // core stays audio-free). Boot finds its own @SpringBootApplication for the jar.
    implementation(project(":spectro-cli"))
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-websocket")
    // Logging night: lift Logback off Boot 3.5.3's managed 1.5.18 — the
    // catalog's 1.5.38 carries the 2026 CVE fixes. The shared logback.xml
    // (from spectro-cli) rules both faces: WARN-quiet console, file diagnostics.
    implementation(libs.logback.classic)

    testImplementation("org.springframework.boot:spring-boot-starter-test")
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
    // The store/config resolve ~/.spectro from user.home at class-load time;
    // pointing user.home into the build directory keeps tests off the real home.
    systemProperty("user.home", layout.buildDirectory.dir("test-home").get().asFile.absolutePath)
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
    // resolves <root>/.spectro/settings.json — where the mcpServers block lives.
    workingDir = rootProject.projectDir
}
