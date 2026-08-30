// The built-in scenarios, ported from the LLM_Simulator (all bilingual).
// Each is a Dsl the compiler turns into a deterministic RunEvent stream —
// scripted demo runs that need no server, no key and no Ollama.

import type { Dsl, DslPhase, Localized, Step } from "./dsl";

const buildplan: Dsl = {
  id: "buildplan",
  name: { en: "build_plan · 1 subagent", de: "build_plan · 1 Subagent" },
  prompt: {
    en: 'Add a --version flag to the Java CLI "spectroscope". Plan it first with the build_plan tool (max 5 steps, do not write files), then show me the plan.',
    de: 'Füge der Java-CLI "spectroscope" ein --version-Flag hinzu. Plane es zuerst mit dem build_plan-Tool (max. 5 Schritte, keine Dateien schreiben), dann zeig mir den Plan.',
  },
  provider: "ollama",
  steps: [
    {
      think: {
        en: "The user wants a plan. I delegate it to a planner subagent via build_plan.",
        de: "Der User will einen Plan. Ich delegiere ihn an einen Planer-Subagenten via build_plan.",
      },
    },
    {
      spawn: "worker-1",
      label: "build_plan",
      task: {
        en: "Plan how to add a --version flag. Max 5 steps, no files.",
        de: "Plane das Hinzufügen eines --version-Flags. Max. 5 Schritte, keine Dateien.",
      },
      steps: [
        {
          think: {
            en: "First I load the 'writing-plans' skill.",
            de: "Zuerst lade ich die 'writing-plans'-Skill.",
          },
        },
        { status: { en: "Reading task and existing files", de: "Aufgabe und vorhandene Dateien lesen" } },
        {
          say: {
            en: "# Plan: --version flag\n1. picocli @Option …",
            de: "# Plan: --version-Flag\n1. picocli @Option …",
          },
        },
      ],
    },
    {
      think: {
        en: "The plan is solid. I verify the current Main class.",
        de: "Der Plan ist solide. Ich prüfe die aktuelle Main-Klasse.",
      },
    },
    {
      read: "spectro-cli/src/main/java/dev/spectroscope/cli/Main.java",
      result: { en: "public final class Main { … }", de: "public final class Main { … }" },
    },
    {
      run: "./gradlew test --quiet",
      gate: "allow",
      result: {
        en: "BUILD SUCCESSFUL in 12s\n42 tests, 0 failures",
        de: "BUILD SUCCESSFUL in 12s\n42 Tests, 0 Fehler",
      },
    },
    { mcp: "notes__search_notes", input: { query: "version flag conventions", limit: 5 }, gate: "deny" },
    {
      think: {
        en: "Even without the notes the plan is enough.",
        de: "Auch ohne die Notizen reicht der Plan.",
      },
    },
    {
      say: {
        en: "Here is the finished 5-step plan for the --version flag …",
        de: "Hier ist der fertige 5-Schritte-Plan für das --version-Flag …",
      },
    },
  ],
};

const fanout: Dsl = {
  id: "fanout",
  fleet: true,
  name: { en: "Review fan-out · 3 subagents", de: "Review-Fan-out · 3 Subagenten" },
  prompt: {
    en: "Review the open PR thoroughly: bugs, performance and security. Check them in parallel, then summarize by priority.",
    de: "Prüfe den offenen PR gründlich: Bugs, Performance und Sicherheit. Prüfe parallel, dann fasse nach Priorität zusammen.",
  },
  provider: "ollama",
  steps: [
    {
      think: {
        en: "I fan out into three parallel reviewers.",
        de: "Ich fächere in drei parallele Reviewer auf.",
      },
    },
    {
      fanout: {
        label: "review",
        tool: "review",
        agents: [
          {
            id: "bugs",
            task: { en: "Find bugs in the diff", de: "Finde Bugs im Diff" },
            steps: [
              { think: { en: "I check null checks and bounds.", de: "Ich prüfe Null-Checks und Grenzen." } },
              { status: { en: "checking null checks", de: "prüfe Null-Checks" } },
              { say: { en: "## Bugs\n- Off-by-one in the pager.", de: "## Bugs\n- Off-by-one im Pager." } },
            ],
          },
          {
            id: "perf",
            task: { en: "Check performance", de: "Prüfe Performance" },
            steps: [
              { think: { en: "I look for N+1 queries.", de: "Ich suche N+1-Queries." } },
              { status: { en: "checking queries", de: "prüfe Queries" } },
              {
                say: {
                  en: "## Performance\n- N+1 in ListRepo.findAll().",
                  de: "## Performance\n- N+1 in ListRepo.findAll().",
                },
              },
            ],
          },
          {
            id: "security",
            task: { en: "Check security", de: "Prüfe Sicherheit" },
            steps: [
              { think: { en: "I check injection and secrets.", de: "Ich prüfe Injection und Secrets." } },
              { read: "src/main/java/app/Db.java", result: 'String sql = "SELECT * FROM u WHERE id=" + id;' },
              { status: { en: "checking injection", de: "prüfe Injection" } },
              {
                say: {
                  en: "## Security\n- SQL concat → injection.",
                  de: "## Sicherheit\n- SQL-Concat → Injection.",
                },
              },
            ],
          },
        ],
      },
    },
    {
      think: {
        en: "All three reviews are back. I prioritize the security finding.",
        de: "Alle drei Reviews sind zurück. Ich priorisiere den Security-Fund.",
      },
    },
    {
      say: {
        en: "Summary: 1 critical security finding, 1 bug, 1 performance issue …",
        de: "Zusammenfassung: 1 kritischer Security-Fund, 1 Bug, 1 Performance-Problem …",
      },
    },
  ],
};

/** The scaling fixture (card 287): eight parallel workers, enough of them on
 *  the disk, the shell and the MCP chain that the grid seating, the per-child
 *  station rails and the station-user strip are all exercised by one replay.
 *  Worker eight touches no station on purpose — the honest no-rail case. */
const fanoutEight: Dsl = {
  id: "fanout-eight",
  name: { en: "Scaling fan-out · 8 subagents", de: "Scaling-Fan-out · 8 Subagenten" },
  prompt: {
    en: "Survey the repo from eight angles at once and report back.",
    de: "Untersuche das Repo aus acht Blickwinkeln gleichzeitig und berichte.",
  },
  provider: "ollama",
  steps: [
    { think: { en: "Eight angles, eight workers.", de: "Acht Blickwinkel, acht Worker." } },
    {
      fanout: {
        label: "survey",
        tool: "survey",
        agents: [
          {
            id: "one",
            task: { en: "scout the build", de: "erkunde den Build" },
            steps: [
              { status: { en: "running the build", de: "Build läuft" } },
              { run: "./gradlew build -x test", result: "BUILD SUCCESSFUL in 41s" },
              { usage: { in: 41_000, out: 900 } },
              { say: { en: "build is green", de: "Build ist grün" } },
            ],
          },
          {
            id: "two",
            task: { en: "write the survey notes", de: "schreibe die Notizen" },
            steps: [
              { status: { en: "writing notes", de: "schreibe Notizen" } },
              { write: "docs/survey/notes.md", result: "Wrote: docs/survey/notes.md (2311 bytes)" },
              { usage: { in: 22_000, out: 1_400 } },
              { say: { en: "notes written", de: "Notizen geschrieben" } },
            ],
          },
          {
            id: "three",
            task: { en: "read the entrypoints", de: "lies die Einstiege" },
            steps: [
              { status: { en: "reading main", de: "lese main" } },
              { read: "src/main/java/app/Main.java", result: "public final class Main { … }" },
              { usage: { in: 35_000, out: 700 } },
              { say: { en: "entrypoints mapped", de: "Einstiege kartiert" } },
            ],
          },
          {
            id: "four",
            task: { en: "count the tests", de: "zähle die Tests" },
            steps: [
              { status: { en: "counting", de: "zähle" } },
              { run: "grep -rc @Test src/test | wc -l", result: "312" },
              { usage: { in: 18_000, out: 300 } },
              { say: { en: "312 test files", de: "312 Testdateien" } },
            ],
          },
          {
            id: "five",
            task: { en: "check the board", de: "prüfe das Board" },
            steps: [
              { status: { en: "asking the board", de: "frage das Board" } },
              { mcp: "notes__search_notes", input: { query: "open cards" }, result: "3 open cards" },
              { usage: { in: 27_000, out: 500 } },
              { say: { en: "three cards open", de: "drei Karten offen" } },
            ],
          },
          {
            id: "six",
            task: { en: "draft the summary file", de: "entwirf die Zusammenfassung" },
            steps: [
              { status: { en: "drafting", de: "entwerfe" } },
              { write: "docs/survey/summary.md", result: "Wrote: docs/survey/summary.md (1102 bytes)" },
              { usage: { in: 30_000, out: 2_100 } },
              { say: { en: "summary drafted", de: "Zusammenfassung entworfen" } },
            ],
          },
          {
            id: "seven",
            task: { en: "probe the dev server", de: "prüfe den Dev-Server" },
            steps: [
              { status: { en: "probing :8080", de: "prüfe :8080" } },
              { run: "curl -s -o /dev/null -w '%{http_code}' localhost:8080", result: "200" },
              { usage: { in: 12_000, out: 250 } },
              { say: { en: "server answers 200", de: "Server antwortet 200" } },
            ],
          },
          {
            id: "eight",
            task: { en: "summarize the risks", de: "fasse die Risiken zusammen" },
            steps: [
              { status: { en: "thinking it through", de: "denke es durch" } },
              {
                think: {
                  en: "No station for this one — thinking only.",
                  de: "Keine Station hier — nur Denken.",
                },
              },
              { usage: { in: 52_000, out: 3_200 } },
              { say: { en: "two risks, both small", de: "zwei Risiken, beide klein" } },
            ],
          },
        ],
      },
    },
    { think: { en: "All eight are back.", de: "Alle acht sind zurück." } },
    { usage: { in: 180_000, out: 4_000 } },
    {
      say: {
        en: "Survey done: build green, 312 test files, three cards open, two small risks.",
        de: "Untersuchung fertig: Build grün, 312 Testdateien, drei Karten offen, zwei kleine Risiken.",
      },
    },
  ],
};

const permission: Dsl = {
  id: "permission",
  name: { en: "Permission gate · blocked & allowed", de: "Permission-Gate · blockiert & erlaubt" },
  prompt: {
    en: "Clean up the data/tmp directory, then show me the git status.",
    de: "Räum das Verzeichnis data/tmp auf, dann zeig mir den Git-Status.",
  },
  provider: "ollama",
  steps: [
    {
      think: {
        en: "Deleting is risky, that needs your approval.",
        de: "Löschen ist riskant, das braucht deine Freigabe.",
      },
    },
    { run: "rm -rf data/tmp", gate: "deny" },
    {
      think: {
        en: "Denied. I delete nothing and only take a look.",
        de: "Abgelehnt. Ich lösche nichts und schaue nur.",
      },
    },
    { list: "data/tmp", result: "cache.bin\nsession.log" },
    { run: "git status --short", gate: "allow", result: " M src/app.ts" },
    {
      say: {
        en: "I deleted nothing (denied). Git shows one changed file.",
        de: "Ich habe nichts gelöscht (abgelehnt). Git zeigt eine geänderte Datei.",
      },
    },
  ],
};

const diskshell: Dsl = {
  id: "diskshell",
  name: { en: "Disk & shell · read / write", de: "Disk & Shell · lesen / schreiben" },
  prompt: {
    en: "Read src/config.json, write the updated version, list src/ and run the tests.",
    de: "Lies src/config.json, schreib die aktualisierte Version, liste src/ und führ die Tests aus.",
  },
  provider: "ollama",
  steps: [
    { think: { en: "First read the config.", de: "Zuerst die Config lesen." } },
    { read: "src/config.json", result: '{ "retries": 3 }' },
    { think: { en: "Now write the new version.", de: "Jetzt die neue Version schreiben." } },
    { write: "src/config.json", result: "ok, wrote 1 file" },
    { list: "src", result: "app.ts\nconfig.json\nindex.ts" },
    { think: { en: "And run the tests.", de: "Und die Tests ausführen." } },
    { run: "npm test", gate: "allow", result: "12 passed, 0 failed" },
    {
      say: {
        en: "Config updated (retries 3→5), src/ listed, tests green.",
        de: "Config aktualisiert (retries 3→5), src/ gelistet, Tests grün.",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// AGENTS.md — the agent reads the workspace's AGENTS.md and visibly honours it:
// it refuses to touch a generated/ file (a rule from the file) and runs the
// tests before finishing (another rule). Shows that workspace house-rules bind
// the agent, not just the project's SPECTRO.md.
// ---------------------------------------------------------------------------
const agentsmd: Dsl = {
  id: "agentsmd",
  name: { en: "AGENTS.md · workspace house-rules", de: "AGENTS.md · Workspace-Hausregeln" },
  prompt: {
    en: "Change the greeting in generated/messages.ts and make sure the tests still pass.",
    de: "Ändere die Begrüßung in generated/messages.ts und stell sicher, dass die Tests weiter grün sind.",
  },
  provider: "ollama",
  steps: [
    {
      think: {
        en: "First I read the workspace's AGENTS.md — its house-rules bind me.",
        de: "Zuerst lese ich die AGENTS.md des Workspace — ihre Hausregeln binden mich.",
      },
    },
    {
      read: "AGENTS.md",
      result: {
        en: "# Agent instructions\n- Always run the tests before finishing.\n- Never edit anything under generated/ — it is machine-written.",
        de: "# Agent-Anweisungen\n- Führe vor dem Abschluss immer die Tests aus.\n- Ändere niemals etwas unter generated/ — es ist maschinengeschrieben.",
      },
    },
    {
      think: {
        en: "generated/messages.ts is off-limits per AGENTS.md. I edit the source template it is generated from, and leave the generated file untouched.",
        de: "generated/messages.ts ist laut AGENTS.md tabu. Ich ändere die Quell-Vorlage, aus der sie generiert wird, und lasse die generierte Datei in Ruhe.",
      },
    },
    { read: "src/messages.template.ts", result: 'export const greeting = "hello";' },
    { write: "src/messages.template.ts", result: "ok, wrote 1 file" },
    {
      think: {
        en: "AGENTS.md says: run the tests before finishing.",
        de: "AGENTS.md sagt: vor dem Abschluss die Tests ausführen.",
      },
    },
    { run: "npm test", gate: "allow", result: "14 passed, 0 failed" },
    {
      say: {
        en: "Followed AGENTS.md: left generated/ untouched, edited the source template instead, and ran the tests (green) before finishing.",
        de: "AGENTS.md befolgt: generated/ unangetastet gelassen, stattdessen die Quell-Vorlage geändert und vor dem Abschluss die Tests ausgeführt (grün).",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Coding — a realistic dev run in FOUR phases, parallel where it should be:
// Explore (main reads) → Plan (planner subagent) → Implement (two parallel
// workers, each WRITES a file) → Verify (gated test run). Stays within the
// map's 3-subagent budget: 1 planner + 2 workers.
// ---------------------------------------------------------------------------
const coding: Dsl = {
  id: "coding",
  fleet: true,
  name: { en: "Coding · 4 phases, parallel workers", de: "Coding · 4 Phasen, parallele Worker" },
  prompt: {
    en: "Add retry logic to the HTTP client and cover it with a test. Explore first, plan, implement in parallel, then verify.",
    de: "Füge dem HTTP-Client Retry-Logik hinzu und decke sie mit einem Test ab. Erst erkunden, dann planen, parallel implementieren, dann verifizieren.",
  },
  provider: "ollama",
  steps: [
    {
      think: {
        en: "Phase 1/4 — EXPLORE. I read the client and its test before touching anything.",
        de: "Phase 1/4 — ERKUNDEN. Ich lese den Client und seinen Test, bevor ich etwas anfasse.",
      },
    },
    {
      read: "src/http/client.ts",
      result: "export async function get(url) { return fetch(url); } // no retries",
    },
    { read: "test/client.test.ts", result: "it('gets', …) // happy path only" },
    {
      think: {
        en: "Phase 2/4 — PLAN. A planner subagent drafts the steps.",
        de: "Phase 2/4 — PLANEN. Ein Planer-Subagent entwirft die Schritte.",
      },
    },
    {
      spawn: "planner",
      label: "build_plan",
      task: {
        en: "Plan retry logic for get(): backoff, max 3 attempts, then a test.",
        de: "Plane Retry-Logik für get(): Backoff, max. 3 Versuche, dazu ein Test.",
      },
      steps: [
        {
          think: {
            en: "Small surface: wrap fetch in a loop with exponential backoff.",
            de: "Kleine Fläche: fetch in eine Schleife mit exponentiellem Backoff wickeln.",
          },
        },
        { status: { en: "drafting the 3-step plan", de: "entwerfe den 3-Schritte-Plan" } },
        {
          say: {
            en: "# Plan\n1. retry(fn, 3, backoff) helper\n2. use it in get()\n3. test: fails twice, succeeds third",
            de: "# Plan\n1. retry(fn, 3, backoff)-Helfer\n2. in get() verwenden\n3. Test: scheitert zweimal, klappt beim dritten",
          },
        },
      ],
    },
    {
      think: {
        en: "Phase 3/4 — IMPLEMENT. Two workers in parallel: code and test.",
        de: "Phase 3/4 — IMPLEMENTIEREN. Zwei Worker parallel: Code und Test.",
      },
    },
    {
      fanout: {
        label: "develop",
        tool: "develop",
        agents: [
          {
            id: "impl",
            task: {
              en: "Implement retry() and wire it into get()",
              de: "retry() implementieren und in get() einbauen",
            },
            steps: [
              {
                think: {
                  en: "Loop, await backoff, rethrow on the last attempt.",
                  de: "Schleife, Backoff awaiten, beim letzten Versuch rethrown.",
                },
              },
              { status: { en: "writing src/http/retry.ts", de: "schreibe src/http/retry.ts" } },
              { write: "src/http/retry.ts", result: "ok, wrote 1 file" },
              {
                say: {
                  en: "retry() in place, get() now uses it.",
                  de: "retry() steht, get() nutzt es jetzt.",
                },
              },
            ],
          },
          {
            id: "tester",
            task: {
              en: "Write the failing-then-passing retry test",
              de: "Den erst-rot-dann-grün Retry-Test schreiben",
            },
            steps: [
              {
                think: {
                  en: "Mock fetch: two rejections, then a 200.",
                  de: "fetch mocken: zwei Rejections, dann ein 200.",
                },
              },
              { status: { en: "writing test/retry.test.ts", de: "schreibe test/retry.test.ts" } },
              { write: "test/retry.test.ts", result: "ok, wrote 1 file" },
              { say: { en: "Test covers the backoff path.", de: "Der Test deckt den Backoff-Pfad ab." } },
            ],
          },
        ],
      },
    },
    {
      think: {
        en: "Phase 4/4 — VERIFY. Run the suite; shell needs your approval.",
        de: "Phase 4/4 — VERIFIZIEREN. Suite ausführen; die Shell braucht deine Freigabe.",
      },
    },
    { run: "npm test", gate: "allow", result: "14 passed, 0 failed (2 new)" },
    {
      say: {
        en: "Done: retry with backoff shipped, covered by a test, suite green — explored, planned, built in parallel, verified.",
        de: "Fertig: Retry mit Backoff eingebaut, per Test abgedeckt, Suite grün — erkundet, geplant, parallel gebaut, verifiziert.",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Research — parallel source sweep, consolidation, then an ADVERSARIAL critic
// pass before the answer ships: 2 researchers + 1 critic (3-subagent budget).
// The critic finds a contradiction, forcing one more lookup — that's the
// didactic beat: consolidation is not the end, review is.
// ---------------------------------------------------------------------------
const research: Dsl = {
  id: "research",
  fleet: true,
  name: {
    en: "Research · consolidate + critical review",
    de: "Research · Konsolidierung + kritisches Review",
  },
  prompt: {
    en: "Should we adopt HTTP/3 for our API edge? Research pros/cons, consolidate, and review the draft critically before answering.",
    de: "Sollten wir HTTP/3 für unsere API-Edge einführen? Recherchiere Pro/Contra, konsolidiere und reviewe den Entwurf kritisch, bevor du antwortest.",
  },
  provider: "ollama",
  steps: [
    {
      think: {
        en: "I sweep two sources in parallel, then merge before anything ships.",
        de: "Ich durchsuche zwei Quellen parallel und führe dann zusammen, bevor etwas rausgeht.",
      },
    },
    {
      fanout: {
        label: "research",
        tool: "research",
        agents: [
          {
            id: "docs",
            task: {
              en: "Scan the IETF/QUIC docs for HTTP/3 trade-offs",
              de: "IETF/QUIC-Doku nach HTTP/3-Trade-offs durchsuchen",
            },
            steps: [
              {
                think: {
                  en: "RFC 9114 and QUIC loss recovery are the core.",
                  de: "RFC 9114 und QUIC Loss Recovery sind der Kern.",
                },
              },
              {
                mcp: "docs__search",
                input: { query: "HTTP/3 QUIC head-of-line blocking" },
                gate: "allow",
                result: "QUIC removes TCP HoL blocking; UDP path required",
              },
              { status: { en: "reading RFC notes", de: "lese RFC-Notizen" } },
              {
                say: {
                  en: "Docs: no TCP head-of-line blocking, but UDP must be open end-to-end.",
                  de: "Doku: kein TCP-Head-of-Line-Blocking, aber UDP muss Ende-zu-Ende offen sein.",
                },
              },
            ],
          },
          {
            id: "web",
            task: { en: "Find real-world adoption reports", de: "Praxisberichte zur Einführung finden" },
            steps: [
              {
                think: {
                  en: "Look for CDN and big-API adoption numbers.",
                  de: "Nach CDN- und Big-API-Adoptionszahlen suchen.",
                },
              },
              {
                mcp: "web__search",
                input: { query: "HTTP/3 production adoption report" },
                gate: "allow",
                result: "major CDNs default to h3; some corp networks still block UDP/443",
              },
              { status: { en: "collecting adoption data", de: "sammle Adoptionsdaten" } },
              {
                say: {
                  en: "Field reports: CDNs default to h3; corporate networks blocking UDP are the main regression risk.",
                  de: "Praxis: CDNs defaulten auf h3; UDP-blockende Firmennetze sind das Hauptrisiko.",
                },
              },
            ],
          },
        ],
      },
    },
    {
      think: {
        en: "CONSOLIDATE. Both sweeps agree on the upside; the risk is UDP reachability. Drafting.",
        de: "KONSOLIDIEREN. Beide Recherchen einig beim Nutzen; das Risiko ist UDP-Erreichbarkeit. Ich entwerfe.",
      },
    },
    {
      say: {
        en: "Draft: adopt HTTP/3 at the edge with TCP fallback (Alt-Svc), because HoL blocking disappears and CDNs already default to it.",
        de: "Entwurf: HTTP/3 an der Edge einführen mit TCP-Fallback (Alt-Svc), weil HoL-Blocking verschwindet und CDNs es bereits defaulten.",
      },
    },
    {
      spawn: "critic",
      label: "review",
      task: {
        en: "Challenge the draft: what breaks it? Check the fallback claim.",
        de: "Fordere den Entwurf heraus: Woran scheitert er? Prüfe die Fallback-Behauptung.",
      },
      steps: [
        {
          think: {
            en: "The draft assumes Alt-Svc fallback is seamless — is it, on first connect?",
            de: "Der Entwurf nimmt an, der Alt-Svc-Fallback sei nahtlos — ist er das beim Erstkontakt?",
          },
        },
        { status: { en: "attacking the fallback assumption", de: "greife die Fallback-Annahme an" } },
        {
          say: {
            en: "CONTRADICTION: first connections are TCP anyway (Alt-Svc is learned), so 'seamless h3-first' overstates it. Also: measure UDP-blocked share before committing.",
            de: "WIDERSPRUCH: Erstverbindungen laufen ohnehin über TCP (Alt-Svc wird erst gelernt), 'nahtlos h3-first' übertreibt also. Außerdem: UDP-Block-Anteil messen, bevor wir uns festlegen.",
          },
        },
      ],
    },
    {
      think: {
        en: "The critic is right — I verify the UDP-blocked share before finalizing.",
        de: "Der Kritiker hat recht — ich prüfe den UDP-Block-Anteil, bevor ich abschließe.",
      },
    },
    {
      mcp: "web__search",
      input: { query: "share of clients with UDP 443 blocked" },
      gate: "allow",
      result: "~3-5% of enterprise clients; consumer <1%",
    },
    {
      say: {
        en: "Final: adopt HTTP/3 at the edge. First contact stays TCP (Alt-Svc upgrade), ~3-5% enterprise clients stay on h2 — acceptable. Rollout with per-network fallback metrics.",
        de: "Final: HTTP/3 an der Edge einführen. Erstkontakt bleibt TCP (Alt-Svc-Upgrade), ~3–5 % Enterprise-Clients bleiben auf h2 — akzeptabel. Rollout mit Fallback-Metriken pro Netz.",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Context window — the code.claude.com/docs "context window" story, played
// live: three big reads fill the gauge (ok → warn → high), then a compaction
// squeezes the history into a summary (the contextometer pulses and drops),
// and the run continues on the compacted window. No subagents — the gauge is
// the protagonist.
// ---------------------------------------------------------------------------
const CTX = (convoTokens: number) => ({
  context: {
    parts: [
      { label: "system prompt", chars: 1024, estTokens: 256 },
      { label: "tool schemas", chars: 4224, estTokens: 1056 },
      { label: "conversation", chars: convoTokens * 4, estTokens: convoTokens },
    ],
  },
});

const context: Dsl = {
  id: "context",
  name: { en: "Context window · fill & compact", de: "Context-Window · füllen & kompaktieren" },
  prompt: {
    en: "Read all three architecture docs and give me one summary. They are long — manage your context window.",
    de: "Lies alle drei Architektur-Dokus und gib mir EINE Zusammenfassung. Sie sind lang — verwalte dein Context-Window.",
  },
  provider: "ollama",
  steps: [
    {
      think: {
        en: "Three long docs. Every read lands in my context window — watch the gauge.",
        de: "Drei lange Dokus. Jeder Read landet in meinem Context-Window — beobachte die Anzeige.",
      },
    },
    { read: "docs/01-architecture.md", result: "(9,000 lines of architecture notes …)" },
    {
      say: {
        en: "Chapter 1 digested: the host, two bridges, one gateway VM.",
        de: "Kapitel 1 verdaut: der Host, zwei Bridges, eine Gateway-VM.",
      },
    },
    CTX(26400),
    { think: { en: "A quarter full. Next document.", de: "Ein Viertel voll. Nächstes Dokument." } },
    { read: "docs/02-network-topology.md", result: "(12,000 lines: four nets, IP plan, WireGuard …)" },
    {
      say: {
        en: "Chapter 2 digested: four nets, the lab bridge is isolated.",
        de: "Kapitel 2 verdaut: vier Netze, die Lab-Bridge ist isoliert.",
      },
    },
    CTX(63800),
    {
      think: {
        en: "Over 60% — the meter turns amber. One more read fits.",
        de: "Über 60 % — die Anzeige wird gelb. Ein Read passt noch.",
      },
    },
    { read: "docs/08-rebuild-runbook.md", result: "(15,000 lines: the full rebuild runbook …)" },
    {
      say: {
        en: "Chapter 3 digested: the rebuild runbook, step by step.",
        de: "Kapitel 3 verdaut: das Rebuild-Runbook, Schritt für Schritt.",
      },
    },
    CTX(87200),
    {
      think: {
        en: "87% — nearly full. The harness now COMPACTS: old turns become one summary.",
        de: "87 % — fast voll. Der Harness KOMPAKTIERT jetzt: alte Turns werden EINE Zusammenfassung.",
      },
    },
    { compact: { removedTurns: 6, summaryChars: 3200 } },
    {
      think: {
        en: "The window is small again; the summary carries the essence forward.",
        de: "Das Fenster ist wieder klein; die Zusammenfassung trägt die Essenz weiter.",
      },
    },
    {
      say: {
        en: "One summary of all three docs: a single host, four isolated nets, and a rebuild path — delivered on a freshly compacted window.",
        de: "Eine Zusammenfassung aller drei Dokus: ein Host, vier isolierte Netze und ein Rebuild-Pfad — geliefert auf frisch kompaktiertem Fenster.",
      },
    },
  ],
};

const codereview: Dsl = {
  id: "codereview",
  fleet: true,
  name: { en: "Three-lens code review · 3 subagents", de: "Drei-Linsen-Code-Review · 3 Subagenten" },
  prompt: {
    en: "Review parse_ages(csv_line) with three lenses in parallel — correctness, security, readability — then give me a verdict table.",
    de: "Prüfe parse_ages(csv_line) mit drei Linsen parallel — Korrektheit, Sicherheit, Lesbarkeit — und gib mir dann eine Urteilstabelle.",
  },
  provider: "ollama",
  steps: [
    {
      think: {
        en: "I write the target, then fan out three reviewers onto it.",
        de: "Ich schreibe das Ziel, dann fächere ich drei Reviewer darauf auf.",
      },
    },
    {
      write: "review_target.py",
      result: { en: "ok, wrote review_target.py", de: "ok, review_target.py geschrieben" },
    },
    {
      fanout: {
        label: "review",
        tool: "review",
        agents: [
          {
            id: "correctness",
            task: { en: "Check correctness", de: "Prüfe Korrektheit" },
            steps: [
              {
                read: "review_target.py",
                result: "def parse_ages(csv_line): return [eval(a) for a in csv_line.split(',')[1:]]",
              },
              { status: { en: "checking bounds & types", de: "prüfe Grenzen & Typen" } },
              {
                say: {
                  en: "## Correctness\n- Off-by-one: `[1:]` silently drops the first age.",
                  de: "## Korrektheit\n- Off-by-one: `[1:]` verwirft still das erste Alter.",
                },
              },
            ],
          },
          {
            id: "security",
            task: { en: "Check security", de: "Prüfe Sicherheit" },
            steps: [
              {
                read: "review_target.py",
                result: "def parse_ages(csv_line): return [eval(a) for a in csv_line.split(',')[1:]]",
              },
              { status: { en: "checking untrusted input", de: "prüfe ungeprüfte Eingaben" } },
              {
                say: {
                  en: "## Security\n- `eval()` on input → arbitrary code execution.",
                  de: "## Sicherheit\n- `eval()` auf Eingabe → beliebige Codeausführung.",
                },
              },
            ],
          },
          {
            id: "readability",
            task: { en: "Check readability", de: "Prüfe Lesbarkeit" },
            steps: [
              {
                read: "review_target.py",
                result: "def parse_ages(csv_line): return [eval(a) for a in csv_line.split(',')[1:]]",
              },
              { status: { en: "checking names & clarity", de: "prüfe Namen & Klarheit" } },
              {
                say: {
                  en: "## Readability\n- One-letter name `a` hides what each value is.",
                  de: "## Lesbarkeit\n- Ein-Buchstaben-Name `a` verbirgt, was jeder Wert ist.",
                },
              },
            ],
          },
        ],
      },
    },
    {
      think: {
        en: "Three findings back — I merge them into a verdict table.",
        de: "Drei Funde zurück — ich fasse sie in einer Urteilstabelle zusammen.",
      },
    },
    {
      say: {
        en: "| lens | verdict |\n| correctness | off-by-one slice |\n| security | eval() on input |\n| readability | one-letter names |",
        de: "| Linse | Urteil |\n| Korrektheit | Off-by-one-Slice |\n| Sicherheit | eval() auf Eingabe |\n| Lesbarkeit | Ein-Buchstaben-Namen |",
      },
    },
  ],
};

const darkmode: Dsl = {
  id: "darkmode",
  name: { en: "build_plan · dark mode", de: "build_plan · Dark Mode" },
  prompt: {
    en: "Add a dark mode toggle to the web UI. Plan it first with the build_plan tool (max 5 steps, no files), then summarize.",
    de: "Füge der Web-UI einen Dark-Mode-Umschalter hinzu. Plane es zuerst mit dem build_plan-Tool (max. 5 Schritte, keine Dateien), dann fasse zusammen.",
  },
  provider: "ollama",
  steps: [
    {
      think: {
        en: "A planning task — I delegate it to a build_plan subagent.",
        de: "Eine Planungsaufgabe — ich delegiere sie an einen build_plan-Subagenten.",
      },
    },
    {
      spawn: "worker-1",
      label: "build_plan",
      task: {
        en: "Plan a dark-mode toggle. Max 5 steps, no files.",
        de: "Plane einen Dark-Mode-Umschalter. Max. 5 Schritte, keine Dateien.",
      },
      steps: [
        {
          think: {
            en: "I load the 'writing-plans' skill first.",
            de: "Ich lade zuerst die 'writing-plans'-Skill.",
          },
        },
        {
          status: {
            en: "Reading the token layer and the theme switch",
            de: "Token-Ebene und Theme-Umschalter lesen",
          },
        },
        {
          say: {
            en: "# Plan: dark mode\n1. Add a `[data-theme]` token set\n2. A toggle in the header\n3. Persist the choice to localStorage\n4. Respect prefers-color-scheme\n5. Test both themes",
            de: "# Plan: Dark Mode\n1. Ein `[data-theme]`-Token-Set\n2. Ein Umschalter im Header\n3. Die Wahl in localStorage persistieren\n4. prefers-color-scheme beachten\n5. Beide Themes testen",
          },
        },
      ],
    },
    {
      think: {
        en: "The five-step plan covers it. I condense it to three bullets.",
        de: "Der Fünf-Schritte-Plan deckt es ab. Ich verdichte ihn auf drei Punkte.",
      },
    },
    {
      say: {
        en: "Summary:\n- a token-driven `[data-theme]` set\n- a header toggle, persisted\n- honors the OS preference",
        de: "Zusammenfassung:\n- ein token-getriebenes `[data-theme]`-Set\n- ein Header-Umschalter, persistiert\n- respektiert die OS-Vorgabe",
      },
    },
  ],
};

const imagegen: Dsl = {
  id: "imagegen",
  name: { en: "Image generation · draft & refine", de: "Bildgenerierung · Entwurf & Verfeinerung" },
  prompt: {
    en: "Make a poster image: a cat lounging on a beach with sunglasses and a cocktail. Draft one, then refine it.",
    de: "Erzeuge ein Poster-Bild: eine Katze am Strand mit Sonnenbrille und Cocktail. Entwirf eins, dann verfeinere es.",
  },
  provider: "ollama",
  steps: [
    {
      think: {
        en: "I draft an image, look at it, then refine the prompt.",
        de: "Ich entwerfe ein Bild, sehe es an, dann verfeinere ich den Prompt.",
      },
    },
    {
      image: {
        en: "a cat on a beach with sunglasses, holding a cocktail",
        de: "eine Katze am Strand mit Sonnenbrille, mit einem Cocktail",
      },
    },
    {
      say: {
        en: "The draft has the right idea, but the pose is stiff and the light is flat. I refine the prompt.",
        de: "Der Entwurf trifft die Idee, aber die Pose ist steif und das Licht flach. Ich verfeinere den Prompt.",
      },
    },
    {
      // The refined result ships as a bundled demo asset — the agent card
      // (expanded view) and the gallery panel render the REAL image.
      image: {
        en: "A cute fluffy cat relaxing on a beach lounge chair, aviator sunglasses, tropical cocktail with a paper umbrella, palm trees and turquoise ocean, sunny, photorealistic, high detail",
        de: "Eine flauschige Katze entspannt auf einem Strandliegestuhl, Pilotenbrille, tropischer Cocktail mit Papierschirmchen, Palmen und türkisfarbenes Meer, sonnig, fotorealistisch, hoher Detailgrad",
      },
      asset: "/demo/beach-cat.jpg",
    },
    {
      say: {
        en: "The refined poster lands: relaxed pose, warm light, the cocktail reads clearly — done.",
        de: "Das verfeinerte Poster sitzt: entspannte Pose, warmes Licht, der Cocktail ist klar lesbar — fertig.",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Bug hunt — a CHAT-side fan-out (owner: more subagent scenarios): the main
// agent spawns three lenses over one diff via spawn_agents, then merges.
// Unlike the fleet twins, this one steps through the Lab with subagent cards.
// ---------------------------------------------------------------------------
const bughunt: Dsl = {
  id: "bughunt",
  name: { en: "Bug hunt · 3 lenses as subagents", de: "Bug-Jagd · 3 Linsen als Subagenten" },
  prompt: {
    en: "Hunt bugs in retry.ts with three lenses in parallel — correctness, performance, security — then give me one prioritized list.",
    de: "Jage Bugs in retry.ts mit drei Linsen parallel — Korrektheit, Performance, Sicherheit — dann gib mir EINE priorisierte Liste.",
  },
  provider: "ollama",
  steps: [
    {
      think: {
        en: "One diff, three independent readings. I fan out three subagents, one lens each, and merge their findings by severity.",
        de: "Ein Diff, drei unabhängige Lesarten. Ich fächere drei Subagenten auf, je eine Linse, und merge die Funde nach Schwere.",
      },
    },
    { read: "src/retry.ts" },
    {
      fanout: {
        tool: "spawn_agents",
        agents: [
          {
            id: "correctness-1",
            task: { en: "Read retry.ts for logic bugs", de: "Lies retry.ts auf Logikfehler" },
            steps: [
              { read: "src/retry.ts" },
              {
                think: {
                  en: "The backoff doubles BEFORE the first wait — attempt one already sleeps 2x.",
                  de: "Der Backoff verdoppelt VOR dem ersten Warten — Versuch eins schläft schon 2x.",
                },
              },
              {
                status: {
                  en: "found: off-by-one in the backoff ladder",
                  de: "Fund: Off-by-one in der Backoff-Leiter",
                },
              },
            ],
          },
          {
            id: "perf-1",
            task: { en: "Check retry.ts for hot-path costs", de: "Prüfe retry.ts auf Hot-Path-Kosten" },
            steps: [
              { read: "src/retry.ts" },
              {
                think: {
                  en: "A fresh AbortController per attempt allocates in the hot loop; hoist it.",
                  de: "Ein frischer AbortController pro Versuch alloziert in der heißen Schleife; rausziehen.",
                },
              },
              {
                status: {
                  en: "found: avoidable allocation per retry",
                  de: "Fund: vermeidbare Allokation pro Retry",
                },
              },
            ],
          },
          {
            id: "security-1",
            task: {
              en: "Scan retry.ts for injection and secrets",
              de: "Scanne retry.ts auf Injection und Secrets",
            },
            steps: [
              { read: "src/retry.ts" },
              {
                think: {
                  en: "The retry log prints the full request — including the Authorization header. That is a secret in plain text.",
                  de: "Das Retry-Log druckt den vollen Request — inklusive Authorization-Header. Das ist ein Secret im Klartext.",
                },
              },
              {
                status: {
                  en: "found: bearer token leaks into the log",
                  de: "Fund: Bearer-Token leakt ins Log",
                },
              },
            ],
          },
        ],
      },
    },
    {
      say: {
        en: "Prioritized:\n1. SECURITY — the retry log leaks the Authorization header (fix first)\n2. CORRECTNESS — backoff doubles before the first wait (off-by-one)\n3. PERF — hoist the AbortController out of the loop",
        de: "Priorisiert:\n1. SECURITY — das Retry-Log leakt den Authorization-Header (zuerst fixen)\n2. KORREKTHEIT — Backoff verdoppelt vor dem ersten Warten (Off-by-one)\n3. PERF — AbortController aus der Schleife ziehen",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Research, attacked — sequential subagents (owner): a researcher drafts, an
// adversarial reviewer attacks the draft, the main agent synthesizes what
// SURVIVED. The honest-review choreography as a steppable demo.
// ---------------------------------------------------------------------------
const adversarial: Dsl = {
  id: "adversarial",
  name: {
    en: "Research · draft, attack, synthesize",
    de: "Research · Entwurf, Angriff, Synthese",
  },
  prompt: {
    en: "Should we adopt HTTP/3 at the edge? Research it, then have the draft adversarially reviewed before you answer.",
    de: "Sollten wir HTTP/3 an der Edge einführen? Recherchiere, lass den Entwurf adversarial reviewen und antworte erst dann.",
  },
  provider: "ollama",
  steps: [
    {
      think: {
        en: "Two subagents, in sequence: one drafts the case, one attacks it. I only keep what survives the attack.",
        de: "Zwei Subagenten, nacheinander: einer entwirft die Argumentation, einer greift sie an. Ich behalte nur, was den Angriff übersteht.",
      },
    },
    {
      spawn: "researcher-1",
      task: {
        en: "Draft the case for HTTP/3 at the edge, with sources",
        de: "Entwirf die Argumentation für HTTP/3 an der Edge, mit Quellen",
      },
      steps: [
        { read: "docs/edge-stack.md" },
        {
          think: {
            en: "QUIC removes head-of-line blocking and speeds up lossy-network handshakes; CDN support is broad by now.",
            de: "QUIC beseitigt Head-of-Line-Blocking und beschleunigt Handshakes in lossy Netzen; CDN-Support ist inzwischen breit.",
          },
        },
        {
          status: {
            en: "draft: adopt — faster handshakes, no HoL blocking, broad CDN support",
            de: "Entwurf: einführen — schnellere Handshakes, kein HoL-Blocking, breiter CDN-Support",
          },
        },
      ],
    },
    {
      spawn: "adversary-1",
      task: {
        en: "Attack the draft: find what breaks or is overstated",
        de: "Greif den Entwurf an: finde, was bricht oder übertrieben ist",
      },
      steps: [
        {
          think: {
            en: "UDP is throttled or dropped by some enterprise middleboxes — the fallback path to H2 must stay first-class. And QUIC costs more CPU per byte at the origin.",
            de: "UDP wird von manchen Enterprise-Middleboxes gedrosselt oder verworfen — der Fallback auf H2 muss erstklassig bleiben. Und QUIC kostet am Origin mehr CPU pro Byte.",
          },
        },
        {
          status: {
            en: "attack: 2 hits — middlebox UDP throttling, origin CPU cost. The latency claim SURVIVES.",
            de: "Angriff: 2 Treffer — Middlebox-UDP-Drosselung, Origin-CPU-Kosten. Der Latenz-Claim ÜBERLEBT.",
          },
        },
      ],
    },
    {
      say: {
        en: "Synthesis (post-attack): adopt HTTP/3 at the EDGE only — the latency win survived review; keep H2 fallback first-class (middlebox throttling is real) and leave origin connections on H2 for now (CPU cost).",
        de: "Synthese (nach dem Angriff): HTTP/3 nur an der EDGE einführen — der Latenz-Gewinn überlebte den Review; H2-Fallback erstklassig halten (Middlebox-Drosselung ist real) und Origin-Verbindungen vorerst auf H2 lassen (CPU-Kosten).",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Fleet swarm — a conductor dispatches THREE workers to build different slices
// of a release in parallel, then merges. Authored fleet-first: it reads best in
// the fleet canvas (the topology at a glance), not as a single stepped chat.
// ---------------------------------------------------------------------------
const fleetswarm: Dsl = {
  id: "fleetswarm",
  fleet: true,
  name: { en: "Fleet swarm · conductor + 3 workers", de: "Fleet-Schwarm · Conductor + 3 Worker" },
  prompt: {
    en: "Cut the release: build the binary, write the notes and refresh the docs — in parallel — then merge.",
    de: "Schnür den Release: Binary bauen, Notes schreiben und Docs auffrischen — parallel — dann mergen.",
  },
  provider: "ollama",
  steps: [
    {
      think: {
        en: "Three independent slices — I dispatch a worker for each and let them run in parallel.",
        de: "Drei unabhängige Scheiben — ich schicke je einen Worker los und lasse sie parallel laufen.",
      },
    },
    {
      fanout: {
        label: "dispatch",
        tool: "dispatch",
        agents: [
          {
            id: "worker-build",
            task: { en: "Build the release binary", de: "Das Release-Binary bauen" },
            steps: [
              { think: { en: "Compile, then package.", de: "Kompilieren, dann packen." } },
              { status: { en: "compiling", de: "kompiliere" } },
              { run: "./gradlew build", gate: "allow", result: "BUILD SUCCESSFUL" },
              { say: { en: "Binary built.", de: "Binary gebaut." } },
            ],
          },
          {
            id: "worker-notes",
            task: { en: "Write the release notes", de: "Die Release-Notes schreiben" },
            steps: [
              {
                think: {
                  en: "Summarize the merged changes since the last tag.",
                  de: "Die gemergten Änderungen seit dem letzten Tag zusammenfassen.",
                },
              },
              { write: "release-notes/next.md", result: "ok, wrote 1 file" },
              { say: { en: "Notes drafted.", de: "Notes entworfen." } },
            ],
          },
          {
            id: "worker-docs",
            task: { en: "Refresh the docs", de: "Die Docs auffrischen" },
            steps: [
              {
                think: {
                  en: "Bump the version and the quickstart snippet.",
                  de: "Version und Quickstart-Snippet anheben.",
                },
              },
              { write: "docs/quickstart.md", result: "ok, wrote 1 file" },
              { say: { en: "Docs refreshed.", de: "Docs aufgefrischt." } },
            ],
          },
        ],
      },
    },
    {
      think: {
        en: "All three slices are back. I merge and tag.",
        de: "Alle drei Scheiben sind zurück. Ich merge und tagge.",
      },
    },
    { run: "git tag v1.2.0", gate: "allow", result: "tagged v1.2.0" },
    {
      say: {
        en: "Release cut: binary, notes and docs merged, tagged v1.2.0.",
        de: "Release geschnürt: Binary, Notes und Docs gemergt, v1.2.0 getaggt.",
      },
    },
  ],
};

/** Card 302: the DECLARED workflow — the demo the fan-out deserved.
 *
 * ONLY THE SHAPE IS TAKEN FROM THE MEASUREMENT, and the shape is numbers: one
 * real 13-agent run declared five phases and filled them 1 / 5 / 1 / 1 / 5,
 * two fan-outs of five with three single agents between them. The words here
 * are this file's own — the recording's phase list, its subject and its name
 * are not in this repo and are not going to be. The recording itself never
 * was: it is tens of megabytes of the owner's own material, and it loads
 * through the folder dialog cards 291 and 297 already taught to take a
 * directory.
 *
 * `phases` is what makes this the declared picture rather than the recovered
 * one: the columns exist before a single event is compiled, so the lens draws
 * the spawns into them solid and captions them with these words.
 */
const workflowPhases: Dsl = {
  id: "workflow-phases",
  name: {
    en: "Declared workflow · 5 phases, 13 agents",
    de: "Deklarierter Workflow · 5 Phasen, 13 Agenten",
  },
  prompt: {
    en: "Go over the settings screen in phases: scope it, probe it five ways, merge what comes back, draft the write-up, then audit every claim in it.",
    de: "Geh den Einstellungs-Screen in Phasen durch: abstecken, fünffach abtasten, zusammenlegen, entwerfen, dann jede Aussage nachprüfen.",
  },
  provider: "ollama",
  phases: [
    {
      title: { en: "scope", de: "abstecken" },
      detail: { en: "decide what to look at", de: "festlegen, was betrachtet wird" },
      agents: ["scope"],
    },
    {
      title: { en: "probe", de: "abtasten" },
      detail: { en: "five angles at once", de: "fünf Blickwinkel gleichzeitig" },
      agents: ["probe-1", "probe-2", "probe-3", "probe-4", "probe-5"],
    },
    {
      title: { en: "merge", de: "zusammenlegen" },
      detail: { en: "one picture out of five", de: "ein Bild aus fünfen" },
      agents: ["merge"],
    },
    {
      title: { en: "draft", de: "entwerfen" },
      detail: { en: "write it up", de: "aufschreiben" },
      agents: ["draft"],
    },
    {
      title: { en: "audit", de: "nachprüfen" },
      detail: { en: "every claim, on its own", de: "jede Aussage einzeln" },
      agents: ["audit-1", "audit-2", "audit-3", "audit-4", "audit-5"],
    },
  ],
  steps: [
    {
      think: {
        en: "Five phases, and the middle one and the last one fan out.",
        de: "Fünf Phasen, die mittlere und die letzte fächern auf.",
      },
    },
    {
      spawn: "scope",
      label: "scope",
      task: { en: "scope the pass", de: "stecke den Durchgang ab" },
      steps: [
        { status: { en: "scoping", de: "stecke ab" } },
        {
          list: "src/settings",
          result: "Panel.tsx  Profile.tsx  Notifications.tsx  errors.ts  track.ts",
        },
        { usage: { in: 9_000, out: 600 } },
        { say: { en: "five angles to probe", de: "fünf Blickwinkel zum Abtasten" } },
      ],
    },
    {
      fanout: {
        label: "probe",
        tool: "probe",
        agents: [
          {
            id: "probe-1",
            task: { en: "probe the settings panel", de: "taste das Einstellungs-Panel ab" },
            steps: [
              { status: { en: "reading the panel", de: "lese das Panel" } },
              { read: "src/settings/Panel.tsx", result: "export function Panel() { … }" },
              { usage: { in: 21_000, out: 800 } },
              {
                say: {
                  en: "probe the settings panel — done",
                  de: "taste das Einstellungs-Panel ab — fertig",
                },
              },
            ],
          },
          {
            id: "probe-2",
            task: { en: "probe the profile section", de: "taste den Profil-Abschnitt ab" },
            steps: [
              { status: { en: "reading the profile section", de: "lese den Profil-Abschnitt" } },
              { read: "src/settings/Profile.tsx", result: "export function Profile() { … }" },
              { usage: { in: 21_000, out: 800 } },
              {
                say: {
                  en: "probe the profile section — done",
                  de: "taste den Profil-Abschnitt ab — fertig",
                },
              },
            ],
          },
          {
            id: "probe-3",
            task: { en: "probe the notification toggles", de: "taste die Benachrichtigungs-Schalter ab" },
            steps: [
              { status: { en: "reading the toggles", de: "lese die Schalter" } },
              {
                read: "src/settings/Notifications.tsx",
                result: "export function Notifications() { … }",
              },
              { usage: { in: 21_000, out: 800 } },
              {
                say: {
                  en: "probe the notification toggles — done",
                  de: "taste die Benachrichtigungs-Schalter ab — fertig",
                },
              },
            ],
          },
          {
            id: "probe-4",
            task: { en: "probe the error states", de: "taste die Fehlerzustände ab" },
            steps: [
              { status: { en: "reading the error states", de: "lese die Fehlerzustände" } },
              { read: "src/settings/errors.ts", result: "export const ERRORS = { … }" },
              { usage: { in: 21_000, out: 800 } },
              { say: { en: "probe the error states — done", de: "taste die Fehlerzustände ab — fertig" } },
            ],
          },
          {
            id: "probe-5",
            task: { en: "probe the analytics hooks", de: "taste die Analytics-Hooks ab" },
            steps: [
              { status: { en: "reading the hooks", de: "lese die Hooks" } },
              { read: "src/settings/track.ts", result: "export function track(step: string) { … }" },
              { usage: { in: 21_000, out: 800 } },
              {
                say: {
                  en: "probe the analytics hooks — done",
                  de: "taste die Analytics-Hooks ab — fertig",
                },
              },
            ],
          },
        ],
      },
    },
    {
      spawn: "merge",
      label: "merge",
      task: { en: "merge the five probes", de: "lege die fünf Abtastungen zusammen" },
      steps: [
        { status: { en: "merging", de: "lege zusammen" } },
        { write: "docs/settings/findings.md", result: "Wrote: docs/settings/findings.md (4102 bytes)" },
        { usage: { in: 44_000, out: 2_100 } },
        { say: { en: "one picture, five sources", de: "ein Bild, fünf Quellen" } },
      ],
    },
    {
      spawn: "draft",
      label: "draft",
      task: { en: "draft the write-up", de: "entwirf die Ausarbeitung" },
      steps: [
        { status: { en: "drafting", de: "entwerfe" } },
        { write: "docs/settings/report.md", result: "Wrote: docs/settings/report.md (6820 bytes)" },
        { usage: { in: 31_000, out: 1_900 } },
        { say: { en: "draft is out", de: "Entwurf ist raus" } },
      ],
    },
    {
      fanout: {
        label: "audit",
        tool: "audit",
        agents: [
          {
            id: "audit-1",
            task: { en: "audit the panel claims", de: "prüfe die Panel-Aussagen nach" },
            steps: [
              { status: { en: "re-running the panel checks", de: "prüfe das Panel erneut" } },
              { run: "npm test -- settings/Panel", result: "12 passed" },
              { usage: { in: 12_000, out: 400 } },
              {
                say: {
                  en: "audit the panel claims — checks out",
                  de: "prüfe die Panel-Aussagen nach — stimmt",
                },
              },
            ],
          },
          {
            id: "audit-2",
            task: { en: "audit the profile claims", de: "prüfe die Profil-Aussagen nach" },
            steps: [
              { status: { en: "re-running the profile checks", de: "prüfe das Profil erneut" } },
              { run: "npm test -- settings/Profile", result: "9 passed" },
              { usage: { in: 12_000, out: 400 } },
              {
                say: {
                  en: "audit the profile claims — checks out",
                  de: "prüfe die Profil-Aussagen nach — stimmt",
                },
              },
            ],
          },
          {
            id: "audit-3",
            task: { en: "audit the notification claims", de: "prüfe die Benachrichtigungs-Aussagen nach" },
            steps: [
              {
                status: {
                  en: "re-running the notification checks",
                  de: "prüfe die Benachrichtigungen erneut",
                },
              },
              { run: "npm test -- settings/Notifications", result: "7 passed" },
              { usage: { in: 12_000, out: 400 } },
              {
                say: {
                  en: "audit the notification claims — checks out",
                  de: "prüfe die Benachrichtigungs-Aussagen nach — stimmt",
                },
              },
            ],
          },
          {
            id: "audit-4",
            task: { en: "audit the error claims", de: "prüfe die Fehler-Aussagen nach" },
            steps: [
              { status: { en: "re-running the error checks", de: "prüfe die Fehler erneut" } },
              { run: "npm test -- settings/errors", result: "5 passed" },
              { usage: { in: 12_000, out: 400 } },
              {
                say: {
                  en: "audit the error claims — checks out",
                  de: "prüfe die Fehler-Aussagen nach — stimmt",
                },
              },
            ],
          },
          {
            id: "audit-5",
            task: { en: "audit the analytics claims", de: "prüfe die Analytics-Aussagen nach" },
            steps: [
              { status: { en: "re-running the analytics checks", de: "prüfe Analytics erneut" } },
              { run: "npm test -- settings/track", result: "4 passed" },
              { usage: { in: 12_000, out: 400 } },
              {
                say: {
                  en: "audit the analytics claims — checks out",
                  de: "prüfe die Analytics-Aussagen nach — stimmt",
                },
              },
            ],
          },
        ],
      },
    },
    {
      say: {
        en: "Five phases done: 13 agents, every claim checked on its own.",
        de: "Fünf Phasen fertig: 13 Agenten, jede Aussage einzeln geprüft.",
      },
    },
  ],
};

/* ── Card 314: the workflow whose SHAPE IS THE FAN-OUT ────────────────────
 *
 * `workflowPhases` above is a five-stage pipeline that happens to contain two
 * fan-outs. This one is the other picture: a small scope, ONE wide phase, a
 * sign-off. A release-readiness pass, where the checks in `releaseChecks` run
 * at the same time and one agent turns what comes back into a single answer.
 *
 * WHY EIGHT, and not a number that reads bigger. The Lab's worker grid seats
 * `SEATS_MAX_EXPANDED` = 12 workers expanded and `SEATS_MAX_COMPACT` = 6
 * compact; past the ceiling the map stops drawing and the chip confesses the
 * gap. Eight is the width already exercised at both ends of that range: it is
 * card 287's shipped `fanout-eight`, and `FlowMap`'s fit zoom was dropped to
 * 0.1 for "an expanded eight-worker map". It leaves four seats spare under the
 * ceiling, and it makes a phase box `phaseHeight(8)` = 152px tall against the
 * 107px of card 302's fan-outs of five (both measured, not derived here).
 * `fanoutWorkflow.test.tsx` pins the width against `SEATS_MAX_EXPANDED` rather
 * than against the literal 8, so raising the ceiling frees the width and
 * lowering it below the declaration fails the case, bitten by setting the
 * ceiling to 4.
 *
 * THE COPY IS WRITTEN, NOT COMPUTED, and that is a correction. The first cut
 * assembled the name, both captions, the ask and every line the run says out
 * loud out of THIS array, which felt drift-proof and was the opposite: the
 * cases then derived their expectation from the same array, so "asks for
 * exactly the checks the fan-out runs" could only prove that a join of a list
 * contains that list. It was measured. Renaming one worker's subject to "the
 * release notes", which no agent here checks, left all seventeen cases green.
 *
 * So the two sides are now genuinely two. Everything shown is typed out, in
 * both locales; every expectation is derived from the phases as DECLARED; and
 * `writes the words it shows instead of assembling them` reads this file back
 * to keep one `${…}` from collapsing them into one side again. Bitten in both
 * directions, separately and measured: a ninth check added to this array with
 * the ask left alone turns FIVE cases red (both halves of the name, the copy's
 * counts, the caption under the wide box, and the ask, which stops naming the
 * ninth); dropping one check's name from the ask with the array left alone
 * turns exactly ONE red, the ask's own, and so does reordering two of them.
 * A third direction stayed open through two rounds: the ask could GROW a
 * demand nobody runs. Round two bounded the LIST — a colon, the run, a full
 * stop — after ", and the release notes." tacked onto the joined eight left
 * twenty cases green. That bound the list and not the ask: "Also translate
 * the release notes." as its OWN sentence walked past it, and past the count
 * check, which finds no "<number> checks" in it (EXIT=0, 21 passed). The ask
 * is now cut at its full stops and pinned at THREE sentences, with the middle
 * one ENDING at the run. What that still does not hold is written into the
 * case rather than promised here: a demand smuggled into the closing sentence
 * with no full stop of its own is three sentences and passes, which is why
 * that case is named for its three sentences and not for "exactly".
 *
 * NO VERSION IS NAMED ANYWHERE. The first cut cut "0.11.0" through the ask, a
 * file the run read, a path it wrote and lines the run says out loud, and
 * would have read as stale the day that version shipped. The run reaches for
 * the last tag instead, which is true for as long as the demo exists.
 *
 * THE SCAN THAT KEEPS IT OUT WAS BLIND IN A NEW PLACE EACH ROUND, and every
 * one of them looked fine, so they are written down.
 *   1. It walked the top level and the `spawn` steps for spoken lines and,
 *      for a fan-out worker, collected only the task, the commands, the paths
 *      and the results: sixteen lines per locale — every worker's status band
 *      and every worker's answer — were never read. With "all six say
 *      0.11.0." in `check-pins`, twenty cases stayed green.
 *   2. Round two enumerated the whole `Step` union BY HAND to make the word
 *      EVERYTHING true, and missed `context`, whose `parts[].label` is drawn
 *      as `.context-part-label`. With "the 0.11.0 baseline" planted as one,
 *      twenty-one cases stayed green. The enumeration is no longer a promise:
 *      one walker serves every caller and its last branch assigns to `never`,
 *      so dropping an arm stops `tsc -b` rather than the eye of a reviewer.
 *   3. Its regex kept a hyphen in the lookbehind to spare `Apache-2.0`, going
 *      blind to `spectro-0.11.0`; round two dropped the hyphen and kept `\w`,
 *      which still carries the UNDERSCORE, so `notes_fetch_0.11.0` stayed
 *      invisible one character narrower. The lookbehind now names digits and
 *      the dot and nothing else, because its whole job is "do not start in
 *      the middle of a longer number"; the licence id is excluded by name,
 *      and dropping either exclusion turns a real line red, so neither is
 *      dead code.
 *
 * NO INVENTED VERBS OF OURS EITHER. The checks run as plain scripts of the
 * release repo the story is set in, which nobody reads as our tooling; the one
 * command that IS ours, `spectro doctor`, is a verb the CLI really declares
 * and the test checks it against the CLI's source. An earlier cut typed
 * `./gradlew licenseReport`, `./gradlew apiDiff` and `./gradlew jmh`, none of
 * which this build has.
 */

/** One agent inside a fan-out step, named so the array below can be ANNOTATED
 *  rather than inferred. Inference widened `gate: "allow"` to `string` here
 *  and `npx tsc -b` was the only thing that said so — vitest erases types, so
 *  all thirteen cases were green over code that did not compile. */
type FanoutAgent = {
  id: string;
  /** The noun the ASK has to use for this check. The ask does NOT read this;
   *  it is written out, and the two are held against each other, so an edit to
   *  either side turns the ask's case red.
   *
   *  WHAT THAT DOES NOT HOLD, said plainly because it was once claimed the
   *  other way: this field is test-only data, so the step from an id to a noun
   *  was pure assertion. `check-bench` was rewritten to translate the release
   *  notes — another task, another command, another answer — with its subject
   *  left at "the benchmarks", and all twenty cases stayed green. The one
   *  thread back to the work is `gives each check a noun the worker's own
   *  lines carry`: the head word of the noun has to turn up in something this
   *  worker renders. That holds the noun to the worker's WORDS. Nothing here
   *  holds those words to the work they describe. */
  subject: { en: string; de: string };
  task: Localized;
  steps: Step[];
};

/** The wide phase's workers, authored once. The phase's `agents` list and the
 *  fan-out that spawns them both read this array, so the declaration and the
 *  stream cannot disagree about who ran. */
const releaseChecks: FanoutAgent[] = [
  {
    id: "check-changelog",
    subject: { en: "the changelog", de: "das Changelog" },
    task: { en: "reconcile the changelog", de: "Changelog abgleichen" },
    steps: [
      { status: { en: "reading the merged commits", de: "lese die gemergten Commits" } },
      { run: "git log --oneline $(git describe --tags --abbrev=0)..HEAD", result: "31 commits" },
      { read: "CHANGELOG.md", result: "## Unreleased\n- fleet message verb\n- deep links\n…" },
      { usage: { in: 26_000, out: 900 } },
      {
        say: {
          en: "31 commits, 28 of them in the changelog. Three merges are missing an entry.",
          de: "31 Commits, 28 davon im Changelog. Bei drei Merges fehlt der Eintrag.",
        },
      },
    ],
  },
  {
    id: "check-pins",
    subject: { en: "the version pins", de: "die Versions-Pins" },
    task: { en: "verify the version pins", de: "Versions-Pins prüfen" },
    steps: [
      {
        status: {
          en: "reading the files that carry the version",
          de: "lese die Dateien, die die Version tragen",
        },
      },
      { run: "scripts/version-pins.sh --check", result: "6 files carry the version, 6 agree" },
      { usage: { in: 18_000, out: 700 } },
      {
        say: {
          en: "Six files carry the version, and all six agree with the tag.",
          de: "Sechs Dateien tragen die Version, und alle sechs stimmen mit dem Tag überein.",
        },
      },
    ],
  },
  {
    id: "check-licences",
    subject: { en: "the dependency licences", de: "die Lizenzen" },
    task: { en: "review dependency licences", de: "Lizenzen sichten" },
    steps: [
      { status: { en: "resolving the dependency tree", de: "löse den Abhängigkeitsbaum auf" } },
      { run: "scripts/license-report.sh", result: "214 dependencies, 9 licences" },
      { usage: { in: 22_000, out: 800 } },
      {
        say: {
          en: "Two dependencies are new since the last tag, both Apache-2.0, so nothing copyleft came in.",
          de: "Zwei Abhängigkeiten sind seit dem letzten Tag neu, beide Apache-2.0, also ist nichts Copyleft dazugekommen.",
        },
      },
    ],
  },
  {
    id: "check-api",
    subject: { en: "the public API", de: "die öffentliche API" },
    task: { en: "diff the public API", de: "öffentliche API vergleichen" },
    steps: [
      { status: { en: "comparing against the last tag", de: "vergleiche mit dem letzten Tag" } },
      { run: "scripts/api-diff.sh --against-last-tag", result: "+14 added, 0 removed, 0 changed" },
      { usage: { in: 31_000, out: 1_100 } },
      {
        say: {
          en: "Fourteen additions and nothing removed or changed, so the release stays source compatible.",
          de: "Vierzehn Ergänzungen und nichts entfernt oder geändert, das Release bleibt also quellkompatibel.",
        },
      },
    ],
  },
  {
    id: "check-migrations",
    subject: { en: "the config migration", de: "die Konfigurations-Migration" },
    task: { en: "migrate config, then back", de: "Konfig vor und zurück fahren" },
    steps: [
      {
        status: {
          en: "migrating a settings file from the last release",
          de: "migriere eine Settings-Datei des letzten Releases",
        },
      },
      {
        run: "scripts/migrate-settings.sh --from-previous --dry-run",
        result: "3 keys moved, 1 renamed",
      },
      {
        run: "scripts/migrate-settings.sh --rollback --dry-run",
        result: "restored, checksum matches",
      },
      { usage: { in: 24_000, out: 900 } },
      {
        say: {
          en: "The migration ran forward and back without complaint, and the rolled-back file matches the original byte for byte.",
          de: "Die Migration lief vor und zurück ohne Murren, und die zurückgerollte Datei stimmt Byte für Byte mit dem Original überein.",
        },
      },
    ],
  },
  {
    id: "check-docs",
    subject: { en: "the docs commands", de: "die Doku-Befehle" },
    task: { en: "check the docs commands", de: "Doku-Befehle prüfen" },
    steps: [
      { status: { en: "extracting the shell blocks", de: "ziehe die Shell-Blöcke heraus" } },
      { run: "scripts/check-docs-commands.sh docs/", result: "41 commands, 40 ok, 1 unknown flag" },
      { usage: { in: 19_000, out: 700 } },
      {
        say: {
          en: "One command in the install guide still passes --port, which moved to the config file.",
          de: "Ein Befehl im Installations-Guide übergibt noch --port, das in die Konfigurationsdatei gewandert ist.",
        },
      },
    ],
  },
  {
    id: "check-install",
    subject: { en: "a clean install", de: "eine saubere Installation" },
    task: { en: "smoke-test a clean install", de: "saubere Installation testen" },
    steps: [
      { status: { en: "installing into an empty prefix", de: "installiere in ein leeres Prefix" } },
      { run: "scripts/install-smoke.sh --clean", gate: "allow", result: "installed in 41s" },
      { run: "spectro doctor", result: "12 checks, all green" },
      { usage: { in: 15_000, out: 600 } },
      {
        say: {
          en: "A machine with nothing installed gets to a CLI that passes doctor in 41 seconds.",
          de: "Eine Maschine ohne Vorinstallation kommt in 41 Sekunden zu einer CLI, die doctor besteht.",
        },
      },
    ],
  },
  {
    id: "check-bench",
    subject: { en: "the benchmarks", de: "die Benchmarks" },
    task: { en: "benchmark against the tag", de: "gegen den Tag benchen" },
    steps: [
      { status: { en: "running the benchmark suite", de: "lasse die Benchmark-Suite laufen" } },
      {
        run: "scripts/bench.sh --against-last-tag",
        result: "12 benchmarks, median delta -2.1%",
      },
      { usage: { in: 28_000, out: 1_000 } },
      {
        say: {
          en: "Twelve benchmarks, all within 5% of the last tag. Event replay is 2% faster.",
          de: "Zwölf Benchmarks, alle innerhalb von 5% des letzten Tags. Event-Replay ist 2% schneller.",
        },
      },
    ],
  },
];

/** The noun the ask has to use for each declared check, keyed by the id the
 *  phase declares. Exported for `fanoutWorkflow.test.tsx`, which walks the
 *  phase's agent ids through this table, holds the result against the ask as
 *  WRITTEN, and holds each noun's head word against the lines that worker puts
 *  on screen. Nothing user-visible reads it. */
export const RELEASE_CHECK_SUBJECTS: Record<string, { en: string; de: string }> = Object.fromEntries(
  releaseChecks.map((c) => [c.id, c.subject]),
);

/** The three declared columns, as ids. This is the side every case derives its
 *  expectation from: the counts in the name and in the copy, the rows of each
 *  box, and the list the ask names are all checked against it. */
const fanoutWorkflowRanks: string[][] = [["scope-tag"], releaseChecks.map((c) => c.id), ["sign-off"]];

/** `detail` is not a comment: `WorkflowLens` draws it as `.wf-rankdetail` in
 *  the caption band, under the box whose rows the number counts. */
const fanoutWorkflowPhases: DslPhase[] = [
  {
    title: { en: "scope", de: "abstecken" },
    detail: { en: "name the checks the tag needs", de: "die nötigen Prüfungen benennen" },
    agents: fanoutWorkflowRanks[0],
  },
  {
    title: { en: "check", de: "prüfen" },
    detail: {
      en: "8 independent checks at once",
      de: "8 unabhängige Prüfungen gleichzeitig",
    },
    agents: fanoutWorkflowRanks[1],
  },
  {
    title: { en: "sign off", de: "freigeben" },
    detail: {
      en: "one answer out of 8 reports",
      de: "eine Antwort aus 8 Berichten",
    },
    agents: fanoutWorkflowRanks[2],
  },
];

const fanoutWorkflow: Dsl = {
  id: "fanout-workflow",
  name: {
    en: "Fan-out workflow · 10 agents, 8 abreast",
    de: "Fan-out-Workflow · 10 Agenten, 8 nebeneinander",
  },
  prompt: {
    en: "We are cutting the next release. Scope what has changed since the last tag, then run the 8 release checks in parallel: the changelog, the version pins, the dependency licences, the public API, the config migration, the docs commands, a clean install and the benchmarks. Give me one go/no-go at the end.",
    de: "Wir schneiden das nächste Release. Steck ab, was sich seit dem letzten Tag geändert hat, und lass dann die 8 Release-Prüfungen parallel laufen: das Changelog, die Versions-Pins, die Lizenzen, die öffentliche API, die Konfigurations-Migration, die Doku-Befehle, eine saubere Installation und die Benchmarks. Am Ende will ich ein einziges Go/No-Go.",
  },
  provider: "ollama",
  phases: fanoutWorkflowPhases,
  steps: [
    {
      think: {
        en: "3 phases. The middle one does the work: 8 checks that never wait for each other.",
        de: "3 Phasen. Die mittlere macht die Arbeit: 8 Prüfungen, die nie aufeinander warten.",
      },
    },
    {
      spawn: "scope-tag",
      label: "scope",
      task: { en: "scope the release tag range", de: "Tag-Bereich abstecken" },
      steps: [
        { status: { en: "reading the tag range", de: "lese den Tag-Bereich" } },
        {
          run: "git diff --stat $(git describe --tags --abbrev=0)..HEAD",
          result: "184 files changed, 6 modules",
        },
        { list: "docs/release", result: "CHECKLIST.md  RELEASE-PLAYBOOK.md  DESKTOP-SIGNING.md" },
        { usage: { in: 12_000, out: 800 } },
        {
          say: {
            en: "6 modules moved. The checklist names 8 checks, and none of them depends on another.",
            de: "6 Module haben sich bewegt. Die Checkliste nennt 8 Prüfungen, und keine hängt von einer anderen ab.",
          },
        },
      ],
    },
    { fanout: { label: "check", tool: "release_check", agents: releaseChecks } },
    {
      spawn: "sign-off",
      label: "sign off",
      task: {
        en: "Go/No-Go from 8 reports",
        de: "Go/No-Go aus 8 Berichten",
      },
      steps: [
        {
          status: {
            en: "weighing the 8 reports",
            de: "wäge die 8 Berichte ab",
          },
        },
        {
          write: "docs/release/readiness.md",
          result: "Wrote: docs/release/readiness.md (3140 bytes)",
        },
        { usage: { in: 58_000, out: 2_400 } },
        {
          say: {
            en: "The changelog is missing three entries, and the install guide still passes a flag that moved into the config file. Everything else came back clean. Go, once those two edits are made.",
            de: "Im Changelog fehlen drei Einträge, und der Installations-Guide übergibt noch ein Flag, das in die Konfigurationsdatei gewandert ist. Alles andere kam sauber zurück. Go, sobald diese zwei Änderungen gemacht sind.",
          },
        },
      ],
    },
    {
      say: {
        en: "8 checks ran side by side. The readiness note lists the two things left to fix before the tag.",
        de: "8 Prüfungen liefen nebeneinander. Die Readiness-Notiz listet die zwei Dinge, die vor dem Tag noch zu erledigen sind.",
      },
    },
  ],
};

export const SCENARIOS: Dsl[] = [
  buildplan,
  bughunt,
  adversarial,
  fanout,
  fanoutEight,
  workflowPhases,
  fanoutWorkflow,
  permission,
  diskshell,
  agentsmd,
  coding,
  research,
  context,
  codereview,
  darkmode,
  imagegen,
  fleetswarm,
];
