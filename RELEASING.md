# Releasing to Maven Central

Two modules publish: `dev.spectroscope:spectro-core` and
`dev.spectroscope:spectro-orchestrator`. CLI, server, desktop and web are
applications — they ship as GitHub release assets, never as Maven
artifacts. Publishing runs through the Central Portal
(central.sonatype.com); the old OSSRH/Nexus path is gone.

## One-time setup (owner)

1. **Portal account** on central.sonatype.com (chris@spectroscope.ai).
2. **Namespace `dev.spectroscope`:** claim it in the portal, then prove
   domain control with a DNS TXT record on the APEX of spectroscope.dev
   (Cloudflare → DNS → Add record → Type `TXT`, Name `@`, Content = the
   verification key the portal shows). Click *Verify Namespace* once
   `dig +short TXT spectroscope.dev` returns the key.
3. **GPG key** (artifacts must be signed):

   ```bash
   gpg --gen-key                      # identity: chris@spectroscope.ai
   gpg --list-keys --keyid-format short
   gpg --keyserver keyserver.ubuntu.com --send-keys <KEY_ID>
   gpg --export-secret-keys --armor <KEY_ID> > /tmp/central-signing.asc
   ```

4. **Portal user token** (Account → Generate User Token) plus the key go
   into `~/.gradle/gradle.properties` — NEVER into any repo:

   ```properties
   mavenCentralUsername=<token-username>
   mavenCentralPassword=<token-password>
   signingInMemoryKey=<contents of central-signing.asc, \n-escaped or via env>
   signingInMemoryKeyPassword=<key passphrase>
   ```

   (Env-var alternative for CI: `ORG_GRADLE_PROJECT_mavenCentralUsername`
   etc.) Delete `/tmp/central-signing.asc` afterwards.

## Per release

1. Cut the version: bump `version` in `spectro-core/build.gradle.kts` and
   `spectro-orchestrator/build.gradle.kts` (they move together), commit,
   tag `v<version>`, create the GitHub release with the app assets.
2. Gate: full `./gradlew test` + vitest green, `./gradlew javadoc` clean —
   the javadoc jar is part of the upload and errors abort it.
3. Publish:

   ```bash
   ./gradlew publishToMavenCentral    # upload + validate; release manually in the portal
   # or, once trusted:
   ./gradlew publishAndReleaseToMavenCentral
   ```

4. After the portal releases, artifacts reach Maven Central within
   minutes to hours (search indexing later). Then — and only then — flip
   the website/docs install snippets from "planned" to the real
   coordinates. Central is append-only: there is no unpublishing, only
   new versions.
