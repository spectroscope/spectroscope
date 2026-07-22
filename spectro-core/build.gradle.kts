// spectro-core — the headless harness library. No CLI, no UI, no Spring Boot:
// everything here is constructible with plain `new` and speaks only RunEvents.

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
    // api: JsonNode appears in the public contracts (Tool.inputSchema(),
    // RunEvent.ToolCall.input, ...) — consumers compile against Jackson types.
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
    // SessionStore/SpectroConfig resolve ~/.spectro from user.home at class-load time;
    // pointing user.home into the build directory keeps tests off the real home.
    systemProperty("user.home", layout.buildDirectory.dir("test-home").get().asFile.absolutePath)
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
