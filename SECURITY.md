# security policy

## reporting a vulnerability

Use GitHub's private vulnerability reporting: repository → **Security** tab →
**Report a vulnerability**. GitHub keeps the report private between you and
the maintainer until an advisory is published.

Include what you can: the affected version, steps to reproduce, and what an
attacker gains. A curl transcript beats a paragraph of theory.

This is a small project with one maintainer. Expect an acknowledgment and an
honest assessment on a best-effort timeline — there is no response SLA and no
guaranteed fix date. The intent is that a confirmed finding ships as a fix in
the next release. Please do not open public issues for security findings
before that exchange.

## supported versions

Only the latest release is supported; there are no backports, so a fix ships
as a new version. Maven Central is append-only — published versions are never
replaced — so a security fix is always a version bump, never a silent
overwrite.

## scope

What the project defends, and where its responsibility ends.

In scope:

- **the local fences.** The server binds `127.0.0.1`. One filter checks
  every `/api` request for a loopback peer and a localhost `Host`
  (DNS-rebinding defense) before it reaches a handler, `GET /api/health`
  excepted; origin-fenced endpoints also require an absent-or-loopback
  `Origin` (CSRF defense) — the fence class per endpoint is documented. Refusals are blank
  404s, so a refused caller cannot fingerprint the server. The fences are
  measured with curl; the tables live in `docs/api-collections/`.
- **the permission gate.** Every tool call — files, shell, web, image
  generation, subagents, skills, MCP — passes through one permission broker
  before it executes. A bypass of that broker is a vulnerability.
- **key handling.** API keys are entered masked in the UI or via the CLI and
  written to `~/.spectro/.env` with mode `0600` (best-effort on non-POSIX
  filesystems). A key leaking into a response, a session file, or a log is a
  vulnerability.

Out of scope:

- **the server on an untrusted network.** Localhost-only is a design
  decision: auth, TLS and origin checks for remote callers are deliberately
  out of scope, and the bind stays `127.0.0.1` (stated at the top of the
  server's `application.properties`). Exposing the server through a reverse
  proxy, a port-forward, or a `0.0.0.0` rebind is unsupported — every fence
  assumes a loopback peer.
- **third-party model providers.** What a cloud provider does with your
  requests is between you and the provider. The project's responsibility
  ends at storing your key safely and never logging it.
- **model behavior.** The downloadable local models are third-party open
  models; their downloads are sha256-pinned and each catalogue row links its
  licence and source, but model output is not a security boundary of this
  project.

## verifying what you downloaded

Release assets carry sha256 digests in the GitHub API:

```
gh api repos/spectroscope/spectroscope/releases/latest \
  --jq '.assets[] | {name, digest}'
```

The Homebrew cask pins the same DMG digest, so
`brew install --cask spectroscope/tap/spectroscope` checks it for you.

The macOS disk image and the app inside it are Developer ID signed and
notarized:

```
spctl -a -t open --context context:primary-signature -v spectroscope-0.12.0-arm64.dmg
# accepted, source=Notarized Developer ID
spctl -a -vv /Volumes/spectroscope/spectroscope.app
# accepted, source=Notarized Developer ID
```

Maven Central publishes `.asc` signatures next to every jar and pom:

```
curl -fsO https://repo1.maven.org/maven2/dev/spectroscope/spectro-core/0.12.0/spectro-core-0.12.0.jar.asc
```
