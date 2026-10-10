# P1 Provider Registry Design

Sub-project 1 of the playbook concept (home repository, private, section 6). Written 2026-10-09 against `spectroscope-harness/spectro` main `1cba586c`. Target location after the previous release run: `docs/superpowers/specs/2026-10-09-provider-registry-design.md` in the product repo. Nothing in this file names employer material.

## Goal

One server side answer to two questions for every provider the config knows: is it configured, and does it answer. The chat picker, the settings page, the doctor and, later, the playbook loader read that one answer.

## Owner decisions this spec follows

| Decision | Source |
|---|---|
| Grey out providers that do not answer in the chat picker, reason in the tooltip; nothing hidden | D9, 2026-10-09 |
| A saved key is enough to list a cloud provider; the settings page checks on demand and remembers the last result with its time; a key save checks once; no background polling | D10 |
| `openai` at a private address without a key counts as local in config, doctor and switch | D11 |
| Card 194 is closed; its criterion 6 (an unreachable provider names its address) is a requirement here | D12 |

## Today

Measured by the survey (reader 01, analyst A1) at `1cba586c`:

- Status words are presence checks: `ready`, `needs-key`, `local` (`SpectroConfig.onboardingStatus`, `SpectroConfig.java:2675 to 2677`), `needs-download` for the built-in runtime (`localModelStatus`, `:2772 to 2774`). `/api/config` makes no request (`SessionsController.java:394 to 484`).
- Reachability is probed per request by `/api/models` (`SessionsController.java:727 to 735`) with 1.5 s connect and 2.5 s read (`:755 to 758`) and stored nowhere. A failed cloud call returns a curated list that looks live (`:790`, `:821 to 823`); other providers return an empty list, and the client shows "backend not reachable" for an empty list, which is also what a reachable server with no models returns (`providerModelField.tsx:197 to 200`).
- The picker lists all eight providers and never disables Switch (`ProviderPicker.tsx:136 to 140`, `164 to 168`); the server refuses a keyless cloud switch at submit (`SessionConnection.java:1044 to 1049`).
- `openai` at a private address without a key: `needs-key` in config (`SessionsController.java:432`), `local` in the doctor (`DoctorCommand.java:575`), tolerated by the switch (`SpectroConfig.java:2379 to 2386`). The CLI first run gate refuses it (`SpectroCli.java:234 to 240`).
- The doctor probes `endpoint + "/v1/models"` literally (`DoctorCommand.java:242`) while the server uses `OpenAiCompatProvider.compatPath` (`SessionsController.java:797 to 800`); a base that already ends in `/v1` is probed at a doubled path, and any status below 500 counts as reachable (`DoctorCommand.java:1172`).
- The settings page names the built-in provider `spectro-local` (`SettingsPanel.tsx:899 to 902`), the picker names it `built-in` (`providerPickerMode.ts:28 to 30`).
- The first run sheet tells the reader to put the key in a `.env` next to spectroscope and restart (`Onboarding.tsx:197`); the server reads `~/.spectro/.env` and a saved key takes effect on the next provider build (`SpectroConfig.java:2780 to 2799`).

## Design

### States

A provider's state is derived on every read from two inputs: presence (key present, model file present, endpoint) recomputed each time, and the last check result, the only stored thing.

| State | Meaning | Settled by |
|---|---|---|
| `needs-key` | a key is required and absent; no request goes out | a key save |
| `needs-download` | the built-in model file is missing | the download |
| `configured` | presence is satisfied; no check result, or the stored result's signature no longer matches the current inputs | a check |
| `reachable` | the last check answered with a well formed list; carries the models, whether the list is live, and the time; zero models is allowed and reads "answers, no model loaded" | the next check |
| `failed` | the last check did not answer; carries one reason code and the address tried | the next check |

Reason codes: `refused`, `timeout`, `rejected-key` (HTTP 401 or 403), `http-<status>`, `bad-answer` (not JSON or no data field).

A fifth credential form is coming with card 478 (a Copilot provider signed in through a device flow, no API key, macOS only, next release). The registry therefore names the credential input generically: `keyPresent` stays the wire field for keyed providers, and a provider whose credential is a sign-in reports `credential: "signed-in" | "not-signed-in"` instead of `needs-key`; the state `needs-key` reads as `needs-signin` for such a provider, and the settings row says "sign in" instead of "key". P1 builds the field and the two words with no provider behind them yet; card 478 fills them.

Kinds, derived from existing config rules, never from a new list: `cloud` when `keyEnvFor(p) != null` and the effective endpoint is not local; `local` when `keylessLocalServers()` contains `p`, or `p` has a preset endpoint and `isLocalEndpoint(endpointFor(p))`; `builtin` for `spectro-local`. The built-in provider is never checked (a check would start llama-server, `ServerLocalRuntime.java:89 to 140`).

Signature stored with a result: `endpoint + "|" + keyPresent + "|" + modelFilePresent`. A result whose signature differs from the current inputs reads as `configured`. A key replaced by another key does not change the signature, so the key save route invalidates that provider.

### Server

New package `dev.spectroscope.server.providers`:

- `ListResult(String outcome, List<String> models, boolean live, String endpoint)`: one model list attempt. `outcome` is `ok` or a reason code.
- `ModelLists`: the three list routines moved out of `SessionsController` (`anthropicModels`, `ollamaModels`, `openaiModels`), each returning a `ListResult` and keeping the exception class and HTTP status instead of throwing them away. `SessionsController.models()` keeps its contract (`List<String>`, curated fallback for anthropic and openai on failure) by delegating.
- `ProviderRegistry`: one per process (`ProviderRegistry.shared()`), constructed with a `Lister` and a clock for tests. `rows(SpectroConfig)` returns one `ProviderRow` per known provider; `check(provider, SpectroConfig)` runs the lister on a virtual thread under a hard outer budget of 5,000 ms (the `DockerPing.pingUnixSocket` pattern, `DockerPing.java:307 to 341`) and stores the result; `checkAll(SpectroConfig, kinds)` runs checks in parallel and waits for all under the same budget; `invalidate(provider)` drops a stored result.
- `ProviderRow(String id, String kind, String state, boolean keyPresent, String endpoint, List<String> models, boolean live, String reason, long checkedAt)`.
- `ProvidersController`: `GET /api/providers` returns `{ "providers": [rows] }` with no network; `POST /api/providers/check?provider=<id|all|local>` runs the checks and returns the rows, fenced like the key route (`LocalOrigin.isLocalOrigin` and `originIsLoopbackOrAbsent`, else 404), because a check sends requests on the operator's keys.
- `/api/config` keeps `providerStatus` unchanged for its existing readers, with one change: a provider that owns an endpoint is judged by `onboardingStatusAt(p, c.endpointFor(p), keyPresent)`, so `openai` at a private address reads `local` (D11). The CLI first run gate applies the same rule. The doctor's OpenAI compatible probe uses `compatPath`.

Budgets are constants in code, not settings (a settable key costs about fifteen touch points, settings survey 2026-09-17): per request 1.5 s connect and 2.5 s read as today, outer budget 5,000 ms per call, time to live 30 s for `local`, 10 min for `cloud`. They are first guesses; the first build measures real latencies against a stalled port and records them in the card.

### Web

- `state/providerRegistry.ts`: the row type, a store read with `useSyncExternalStore`, `refreshProviders()` (GET), `checkProviders(target)` (POST), `rowFor(id)`.
- `providerPickerMode.ts`: `pickerOption(row)` decides `disabled` and the reason key: `needs-key` and `failed` are disabled, everything else is enabled. A `reachable` row with zero models is enabled and the model field says "answers, no model loaded".
- `ProviderPicker.tsx`: on open, refresh the rows and check the `local` kind (localhost calls, bounded); options render `disabled` with the reason as `title`; a note under the select names the reason of a disabled selection; Switch is disabled while the selection is disabled.
- `ProviderStatusSettings.tsx`: a new block in the settings page beside the provider fields, one row per provider: name (`built-in` for `spectro-local`), state in words, key present (cloud only, yes or no, never a value), endpoint (local only), model count with live or fallback, age of the last check, a Check button; and a Check all button. On mount it refreshes and checks `local`. A key save checks that one provider.
- `SettingsPanel.tsx` names the built-in provider through `providerDisplayName`. `Onboarding.tsx:197` names `~/.spectro/.env` and drops "restart".
- Strings in both languages under `prov.*` and `pp.opt*`.

### Data flow

1. Settings or picker opens: `GET /api/providers` (presence plus stored results, no network), then `POST /api/providers/check?provider=local`.
2. A Check button: `POST /api/providers/check?provider=<id>` or `all`.
3. A key save: the existing save route, then the client posts a check for that provider.
4. A playbook loader (P3): `ProviderRegistry.shared().rows(config)` and `check` for each model choice, same words.

## Requirements

1. `GET /api/providers` returns every provider in `SpectroConfig.knownProviders()` with the fields above and sends no request to any provider.
2. `POST /api/providers/check` returns within the outer budget even when a provider accepts the connection and never answers; such a provider reads `failed` with reason `timeout` and its endpoint.
3. A cloud provider with a wrong key reads `failed` with reason `rejected-key` after a check; with no key it reads `needs-key` without a check.
4. A local server that answers with an empty list reads `reachable` with zero models, distinct from `failed`.
5. A row's `live` flag is false whenever the models came from a curated list.
6. The picker lists all eight providers, disables `needs-key` and `failed` rows with the reason in the tooltip, and disables Switch while a disabled row is selected. The chat's current provider stays selectable so the chip never lies.
7. `openai` with a private address and no key reads `local` in `/api/config`, in `spectro doctor` and passes the CLI first run gate.
8. The doctor's OpenAI compatible probe dials `endpoint + compatPath(endpoint, "/models")`.
9. `ProviderListDriftTest` stays green and gains a positive twin: every provider the config knows has a row in `GET /api/providers`.
10. The settings page shows one row per provider with state, key presence, endpoint, model count, age and a Check button, in both languages, in both themes.
11. No new settings key. No background timer. No socket push.
12. `/api/models` keeps its contract for its existing readers.

## Out of scope

A fallback chain at run time (P3). Checking cloud providers on picker open (D10). A registry event stream. Removing `providerStatus` from `/api/config` (its readers stay as they are). The built-in download chooser on the settings page (follow-up card).

## Acceptance scenarios

```
scenario: a stalled local server does not hang the check
  Given lmstudio's address points at a port that accepts and never answers
  When the settings page presses Check for lmstudio
  Then the answer arrives within 5 seconds
  And the row reads failed, timeout, with that address

scenario: the picker greys out a provider that does not answer
  Given ollama is configured and not running
  When the chat picker opens
  Then ollama is listed and disabled
  And its tooltip names the address that was tried
  And Switch is disabled while ollama is selected

scenario: a wrong cloud key is caught by the check, not by the picker
  Given an OPENAI_API_KEY that the service rejects
  When the settings page presses Check for openai
  Then the row reads failed, rejected-key
  And the picker lists openai disabled with that reason

scenario: openai at a private address is local everywhere
  Given openaiBaseUrl is http://192.168.1.10:8080 and no OPENAI_API_KEY
  Then /api/config reports openai as local
  And spectro doctor prints the local line for openai
  And spectro run does not print the first run hint
```
