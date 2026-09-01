// spectro-core — the headless harness library. No CLI, no UI, no Spring Boot:
// everything here is constructible with plain `new` and speaks only RunEvents.

plugins {
    `java-library`
    alias(libs.plugins.maven.central.publish)
}

group = "dev.spectroscope"
version = "0.11.0"

repositories {
    mavenCentral()
}

dependencies {
    // api: JsonNode appears in the public contracts (Tool.inputSchema(),
    // RunEvent.ToolCall.input, ...) — consumers compile against Jackson types.
    // The BOM, not a bare version. MEASURED, which is the only reason this is
    // here rather than a number: ParserMinimalBase(StreamReadConstraints) exists
    // in jackson-core 2.18.2 and NOT in 2.17.2, so a consumer whose classpath
    // pairs databind 2.18 with core 2.17 gets NoSuchMethodError on the first
    // deserialisation — which is the stack the owner sent from outside this repo.
    //
    // Declaring one artifact's version leaves the rest of the family to whatever
    // resolves them. The BOM pins the whole family together, so no resolver can
    // pick them apart, and that guarantee travels to every consumer in the POM
    // rather than only holding inside this build.
    api(platform(libs.jackson.bom))
    api(libs.jackson.databind)

    // implementation: the Anthropic SDK is an internal detail of
    // provider/AnthropicProvider — no other class may import it.
    implementation(libs.anthropic.java)

    // Spring Framework as a plain library (RestClient + declarative HTTP
    // interfaces for the Ollama provider). Still no Boot, no container.
    implementation(libs.spring.web)

    // Stage 6: cron-utils parses/computes cron slots; the executor fires them.
    implementation(libs.cron.utils)
    // Logging night: the core speaks the slf4j API (MDC agent prefix, the
    // Logged autologging proxy) and NEVER ships a backend — the faces do.
    implementation(libs.slf4j.api)
    // The HTTP-interface proxy (HttpServiceProxyFactory) reaches into
    // spring-aop (proxying) and spring-context (conversion service) at runtime.
    implementation(libs.spring.aop)
    implementation(libs.spring.context)

    testImplementation(libs.junit.jupiter)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    // Logging night: a TEST-ONLY backend so the Logged/MDC tests can capture
    // records in-memory (src/test/resources/logback-test.xml keeps the rest
    // of the suite silent). The published core still ships slf4j-api only.
    testImplementation(libs.logback.classic)
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
    // user.home is redirected by the ROOT subprojects block (card 235).
    // ProofOfChainTest and DemoScenariosTest only write outside the build
    // directory when a target is named on the command line; forwarded here
    // because a Test JVM inherits none of Gradle's own -D flags.
    System.getProperty("proof.out")?.let { systemProperty("proof.out", it) }
    System.getProperty("demos.out")?.let { systemProperty("demos.out", it) }
    // Card 357: GoverningNumbersDriftTest regenerates the governing-numbers
    // registry from the source tree under this flag and then fails on purpose,
    // so it cannot be left on in a green build. Same reason as the two above —
    // a Test JVM inherits none of Gradle's own -D flags.
    System.getProperty("governing.rewrite")?.let { systemProperty("governing.rewrite", it) }
}

// Maven Central (card 23): this library publishes through the Central
// Portal as dev.spectroscope:spectro-core — sources and javadoc jars ride
// along, every artifact is signed (RELEASING.md documents the key and
// token setup; without them only the local tasks run).
mavenPublishing {
    publishToMavenCentral()
    signAllPublications()
    pom {
        name.set("spectro-core")
        description.set("Transparent, local-first coding-agent harness for the JVM (Java 21): "
                + "the five-lines Spectro facade, a typed RunEvent stream, tools, MCP, "
                + "sessions and replay — the stream is the observability.")
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
