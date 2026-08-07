plugins {
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("dev.spectroscope:spectro-core:0.7.0")
    // A logging backend so provider warnings are visible; any slf4j binding works.
    runtimeOnly("org.slf4j:slf4j-simple:2.0.18")
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(21) // spectroscope needs Java 21 or newer
}

application {
    // Default main: the cloud run. Switch with -PmainClass=… (see README).
    mainClass.set(
        providers.gradleProperty("mainClass")
            .orElse("dev.spectroscope.samples.fivelines.FiveLines")
    )
}
