# Release notes

One file per version. Newest first.

| Version | Date | Notes |
|---|---|---|
| [0.2.0](v0.2.0.md) | _unreleased (draft)_ | honest provider onboarding, key-from-UI, one key for chat + image, signed + notarized desktop build |
| [0.1.0](v0.1.0.md) | 2026-07-22 | first public release — Maven Central libs + CLI / server / mcp-notes / desktop run kit |

Each release: bump `spectro-core` + `spectro-orchestrator` (Maven Central is
append-only), run the full gate, publish, cut the GitHub release, flip the site.
The ritual is [docs/RELEASE-PLAYBOOK.md](../docs/RELEASE-PLAYBOOK.md).
