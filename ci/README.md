# The local build laboratory

Five stacks, each a Docker Compose project, each on its own port, started and
stopped independently — so two can be compared side by side and the rest stay
out of the way.

```bash
./ci/spectro-ci doctor          can this machine run them
./ci/spectro-ci up jenkins      one
./ci/spectro-ci up concourse    the other, at the same time
./ci/spectro-ci status          what answers, and on which port
./ci/spectro-ci down all
```

| stack | port | what it is |
|---|---|---|
| **jenkins** | 8881 | a controller **and** a separate agent node |
| **concourse** | 8880 | pipelines as YAML, every step its own container |
| **sonar** | 8882 | static analysis over Java and TypeScript |
| **deptrack** | 8883 (API 8884) | what our dependencies are made of, from an SBOM |
| **renovate** | — | dependency updates, run on demand |

All eight images were checked for a `linux/arm64` manifest with
`docker manifest inspect` on 2026-08-05. None emulates.

## Two things to know before you start

**Memory is the binding constraint.** Docker Desktop had **7.7 GiB** of this
machine's 48 GiB when this was written. SonarQube wants ~4 GiB for its embedded
Elasticsearch and Dependency-Track's API server asks for 4 GiB, so `up all` does
not fit. Raise it in Docker Desktop → Settings → Resources, or bring stacks up in
pairs — which is what the per-stack switch is for.

**No container here can sign the DMG.** Docker on macOS is a Linux VM;
`codesign`, `notarytool`, `stapler` and `hdiutil` need the macOS host and its
keychain. Everything else in the release runs in these containers. That one leg
needs an agent on the host — `konzept/BUILD-SERVER.md` says what that costs.

## What running it actually taught us

Every one of these was found by starting the thing, not by reading about it.

- **`security.agentSecret` is not a JCasC attribute.** The controller refuses to
  boot. Jenkins *derives* a node's secret, so it cannot be declared — the agent
  fetches its own at startup from `/computer/<name>/jenkins-agent.jnlp`. That is
  `ci/jenkins/agent-entrypoint.sh`, and it is the step the tutorials leave out.
- **A `jobs:` block needs the `job-dsl` plugin**, and without it JCasC does not
  ignore the block — it refuses to boot.
- **`timestamps()` needs `timestamper`**, and without it the pipeline does not
  lose timestamps, it fails to *compile*.
- **`dir()` creates a sibling `<path>@tmp`.** A job in `/workspace` tries to
  `mkdir /workspace@tmp` at the filesystem root, which nobody may write. The
  mount lives under the agent's home for that reason.
- **A named volume over a path that does not exist in the image is owned by
  root.** `/home/jenkins/.gradle` is created in the Dockerfile so the volume
  inherits the right owner.
- **`sandbox(false)` means a human must approve the script.** A declarative
  pipeline runs in the sandbox without approval, so that is both the working
  setting and the safer one.
- **Concourse's worker needs `CONCOURSE_CONTAINERD_DNS_SERVER`.** Its
  `/etc/resolv.conf` points at Docker's embedded resolver on `127.0.0.11`, which
  a *nested* container cannot reach, so every `npm ci` dies on name resolution.
  The `CONCOURSE_GARDEN_DNS_PROXY_ENABLE` written first was the wrong knob
  entirely — it belongs to the other runtime.
- **`./ci/spectro-ci up` passes `--build`,** because `docker compose up -d`
  alone silently reuses a stale image and you debug yesterday's container.

And the finding that was worth the whole exercise: **build #4 came back 500 of
506**, and all six failures were `SpectroPtyHelperTest`. The PTY helper is C,
built by `scripts/build-spectro-pty.sh` *outside* Gradle, so nothing in a fresh
container builds it. The pipeline builds it now. A gate that had quietly skipped
those six would have been a gate that lies.
