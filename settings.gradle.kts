// The build: five Java modules. spectro-web (Vite/React) and
// spectro-desktop (Electron shell) live next to the Gradle build on purpose —
// business reality: Java backend, JS frontends, separate toolchains.
rootProject.name = "spectroscope"

include("spectro-core", "spectro-cli", "spectro-server", "spectro-mcp-notes", "spectro-orchestrator")
