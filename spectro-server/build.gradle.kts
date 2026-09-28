// spectro-server — the second face: Spring Boot translates between the
// EventStream and the WebSocket, REST serves the session store, and the
// built React UI ships from src/main/resources/static (vite writes it there).
// Spring Boot appears ONLY in this module.

plugins {
    java
    id("org.springframework.boot") version "3.5.3"
}

group = "dev.spectroscope"
version = "0.14.1"

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

// Card 398: the label a test build carries, for example
// "0.13.0-beta (merge-2026-09-24, a1b2c3d, 24.09. 14:05)". scripts/build-label.sh
// computes it and build-desktop-runkit.sh passes it as -Pspectro.buildLabel.
// Empty when the property is absent or empty, and then nothing is stamped.
val buildLabel: String = providers.gradleProperty("spectro.buildLabel").orElse("").get().trim()
require(!buildLabel.contains('\\') && !buildLabel.contains('\n')) {
    "spectro.buildLabel may not contain a backslash or a line break: '$buildLabel'"
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("failed", "skipped")
    }
    // user.home is redirected by the ROOT subprojects block (card 235).
    // BuildLabelStampTest compares the stamp on the test classpath, which is
    // the processResources output, with the label this build was given.
    systemProperty("spectro.test.expectedBuildLabel", buildLabel)
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

// Heap: bootRun is the development face of the same server the DMG ships, so it
// gets the same ceiling. Without this a developer measures a 12 GiB heap on a
// 48 GiB machine while every shipped launch path hands out a third. The number
// is HeapBudget.MAX_RAM_PERCENT and HeapFlagDriftTest holds this file to it.
tasks.named<JavaExec>("bootRun") {
    jvmArgs("-XX:MaxRAMPercentage=33")
}

// Card 90: the repo's own skills ride every artifact (jar, DMG) — seeded into
// ~/.spectro/skills on first start by BundledSkills, absent-only + ledgered.
tasks.processResources {
    // The CATALOGUE rides too, and it is deliberately a different destination.
    //
    // `bundled-skills` is SEEDED into ~/.spectro/skills on first boot and every
    // skill there is appended to the agent's system prompt. Putting 57 foreign
    // skills in that folder would push all of them into every run's context,
    // which is not a gift. The catalogue is carried and NOT seeded: it is the
    // shelf a marketplace install copies FROM (card 182), so nothing reaches an
    // agent until somebody chooses it.
    from(rootProject.layout.projectDirectory.dir(".spectro/skills-catalogue")) {
        into("skills-catalogue")
    }
    from(rootProject.layout.projectDirectory.dir(".spectro/skills")) {
        into("bundled-skills")
    }
    // Card 143: the release pipeline bumps *.kts and *.json — a Java literal is
    // invisible to it, and StarterBundles carried "0.4.1" straight through the
    // 0.5.0 cut. So the version travels with the build instead: this module's
    // version is expanded into ONE resource (scoped by filesMatching — never
    // expand the static/ web bundle, it is full of ${…} lookalikes) and
    // StarterBundles reads it at class-init. StarterVersionDriftTest holds the
    // chain to the build files on disk.
    val moduleVersion = version.toString()
    inputs.property("moduleVersion", moduleVersion)
    // Card 398: the build label rides the same file, as a label= line, only
    // when the build was given one. UTF-8 because a branch name in the label
    // may be outside ASCII; StarterBundles reads it as UTF-8.
    val labelLine = if (buildLabel.isEmpty()) "" else "label=$buildLabel"
    inputs.property("labelLine", labelLine)
    filteringCharset = "UTF-8"
    filesMatching("starter/spectro-version.properties") {
        expand("version" to moduleVersion, "labelLine" to labelLine)
    }
}
