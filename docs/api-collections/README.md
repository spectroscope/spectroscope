# spectroscope REST API collections

The whole REST surface of the spectro-server built from this tree — 48 endpoints in 16 area
folders — as importable collections for the four popular REST clients
(card 132). One table, one generator, four client files.

## Which file is for which client

| Client | File | How |
|---|---|---|
| **Postman** | `spectroscope-api.postman_collection.json` | Import → File. Native Postman Collection v2.1. |
| **Bruno** | `bruno/` | Open Collection → pick the `bruno/` folder. Native `.bru` format, drops straight into git. |
| **Insomnia** | `spectroscope-api.postman_collection.json` | Application menu → Import. Insomnia imports Postman v2.1 directly ([Kong docs](https://developer.konghq.com/insomnia/import-export/)). See `IMPORT-INSOMNIA.md`. |
| **Hoppscotch** | `spectroscope-api.postman_collection.json` | Collections → Import → Postman ([Hoppscotch docs](https://docs.hoppscotch.io/documentation/features/importer)). See `IMPORT-HOPPSCOTCH.md`. |

Postman v2.1 is the lingua franca: all four clients consume it (Bruno
imports it too, but gets a native folder because files-in-git is the point
of Bruno). We deliberately do not hand-write Insomnia v5 YAML or Hoppscotch
JSON — both formats are young and migrate often, and both vendors document
the Postman import as the supported path. The Postman file pins the classic
`schema.getpostman.com` v2.1.0 schema URL because Bruno's importer
allowlists exactly that domain (usebruno/bruno#4190).

## Variables

Every request targets `{{baseUrl}}` = `http://{{host}}:{{port}}`. Change
`host` or `port` once (collection variables in Postman, the `local`
environment in Bruno) and every request re-targets. Insomnia and Hoppscotch
drop collection variables on import — their IMPORT notes carry a paste-ready
environment block for exactly this reason.

| Variable | Default | Meaning |
|---|---|---|
| `host` | `localhost` | Must stay a localhost name — the fences require it (below). |
| `port` | `8080` | The spectro-server port. |
| `baseUrl` | `http://{{host}}:{{port}}` | Composed; do not edit directly. |
| `sessionId` | `20260730-120000-abcdef12` | Placeholder — take a real id from `GET /api/sessions`. |
| `nodeId` | `node-1` | A fleet node id from `GET /api/fleet`. |
| `skillName` | `brainstorming` | A skill name from `GET /api/skills`. |
| `bundleId` | `five-lines` | `five-lines` \| `fleet` \| `multi-agent`. |
| `localModelId` | `qwen3-4b` | A built-in model id from `GET /api/local-model/catalog`. |
| `imageFile` | `0123…cdef.png` | `[0-9a-f]{64}.(png|jpg|webp)` from the image store. |
| `transcriptPath` | `-Users-you-project/session.jsonl` | From `GET /api/claude/transcripts`. |
| `workspaceFilePath` | `README.md` | Root-relative path for `GET /api/file`. |
| `scaffoldDir` | `/tmp/spectro-scaffold` | Existing folder for the scaffold endpoint. |

## The fences, measured

Several endpoints are origin-gated (the 0.3.0 hardening). The good news for
REST clients: **a browserless client sends no `Origin` header, and the
server treats an absent Origin as safe** — from the same machine, targeting
`localhost`, every request in this collection passes. Measured with curl
from loopback against a live the spectro-server built from this tree (2026-07-30):

| endpoint | fence | no Origin | `Origin: http://localhost:<port>` | `Origin: https://evil.example` | `Host: evil.example` |
|---|---|---|---|---|---|
| GET /api/sessions | none | 200 | 200 | 200 | 200 |
| GET /api/settings | host | 200 | 200 | 200 | 404 |
| GET /api/leveling | host+origin | 200 | 200 | 404 | 404 |
| POST /api/leveling/tick | host+origin | 200 | 200 | 404 | 404 |

The two ways a REST client can fence itself out: (a) manually adding a
foreign `Origin` header → 404 on host+origin endpoints; (b) pointing the
client at anything other than `localhost`/`127.0.0.1`/`::1` — a LAN IP or a
rebound DNS name → 404 on every host-fenced endpoint, because the fence
requires both a loopback peer and a localhost `Host` header. Refusals are
blank **404s, never 403** — a refused caller cannot fingerprint the server.

Each request's description carries its own fence class and semantics, so
the answer to "why is this 404?" is always one click away.

## Handle with care

- `DELETE /api/sessions/{id}` **really deletes** and is the one destructive
  endpoint without an origin fence. Replay the collection against a
  throwaway home, not your real `~/.spectro`.
- `DELETE /api/skills/{name}` is **permanent** — the seeding ledger will not
  re-seed a deleted skill on the next boot.
- `POST /api/local-model/download` starts a **multi-gigabyte** download into
  `~/.spectro/models` — keep it out of automated replays.
- `POST /api/fleet/nodes` needs the server started with
  `SPECTRO_ALLOW_SPAWN` **and** a running hub (`SPECTRO_HUB_PORT`) —
  otherwise every answer is 404, by design.
- `POST /api/pick-workspace` blocks up to 120 s on a native macOS dialog.
- `POST /api/explain` and the cloud translate engine spend the operator's
  API key.
- `GET /api/config` establishes the `provider-ready` leveling criterion as
  a side effect when a provider is ready.
- `/ws` and `/ws/shell` are WebSocket endpoints, origin-checked at
  handshake — not REST, not in this collection.

## Regenerating (the drift seam)

```
python3 build_api_collections.py [--source-tree <harness repo>]
```

`endpoints.json` is the single source; the generator validates it (count,
unique ids, area/fence/variable references) and refuses to emit from an
inconsistent table. It also scans the server's controller annotations and
diffs them against the table — an endpoint added to the code fails the
regeneration until the table learns it, and a stale table row fails it too.
The source tree is auto-detected when the generator lives in the harness
repo; elsewhere pass `--source-tree`, or opt out loudly with
`--no-source-scan` (the emissions then carry no proof the table matches the
code). The client files are never edited by hand — a new endpoint ships by
adding one table row and re-running. Output is byte-deterministic: no
timestamps, no randomness (the Postman collection id is a uuid5 of a fixed
name), so a CI diff against a fresh run guards the emissions the same way
the scan guards the table.

## Verification (2026-07-30)

All 28 non-destructive requests (every GET plus the two safe leveling
POSTs, variables substituted) were replayed from the generated table
against a live the spectro-server built from this tree on a fresh throwaway home: **23
answered 200; the five 404s are exactly the documented placeholder-id
cases** (unknown `sessionId` ×2, missing `imageFile`, unknown
`transcriptPath`, `nodeId` without a running hub). Determinism was proven
by running the generator twice into separate directories: `diff -r` is
empty.
