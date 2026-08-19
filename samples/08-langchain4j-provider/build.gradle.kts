plugins {
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("dev.spectroscope:spectro-core:0.10.0")
    // Any LangChain4j model integration works; Ollama keeps the demo key-free.
    implementation("dev.langchain4j:langchain4j-ollama:1.18.0")
    runtimeOnly("org.slf4j:slf4j-simple:2.0.18")
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(21) // spectroscope needs Java 21 or newer
}

application {
    mainClass.set("dev.spectroscope.samples.lc4j.Lc4jDemo")
}
