// Where a Java 21 toolchain comes from when the machine has none.
//
// Every module declares `toolchain { languageVersion = 21 }` so the tests RUN on
// the version CI runs, not merely compile for it. Without this plugin Gradle can
// only use a JDK that is already installed, and on the machine this was written
// on there is only 25 — the build stopped with "Cannot find a Java installation
// … matching {languageVersion=21}".
//
// The honest cost: the first build on a machine without a JDK 21 downloads one,
// roughly 200 MB, once. In exchange the build is reproducible with nothing
// installed but Git, which is worth more than the download — and it is the
// reason no version manager is needed for the build to be correct.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

// The build: five Java modules. spectro-web (Vite/React) and
// spectro-desktop (Electron shell) live next to the Gradle build on purpose —
// business reality: Java backend, JS frontends, separate toolchains.
rootProject.name = "spectroscope"

include("spectro-core", "spectro-cli", "spectro-server", "spectro-mcp-notes", "spectro-orchestrator")
