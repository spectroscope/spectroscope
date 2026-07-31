plugins {
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("dev.spectroscope:spectro-core:0.4.1")
    implementation("dev.spectroscope:spectro-orchestrator:0.4.1")
    runtimeOnly("org.slf4j:slf4j-simple:2.0.18")
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(21) // spectroscope needs Java 21 or newer
}

application {
    mainClass.set("dev.spectroscope.samples.hub.PanelToHub")
}
