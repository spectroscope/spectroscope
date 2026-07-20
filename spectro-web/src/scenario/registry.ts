// The seven built-in scenarios, ported from the LLM_Simulator (all bilingual).
// Each is a Dsl the compiler turns into a deterministic RunEvent stream —
// scripted demo runs that need no server, no key and no Ollama.

import type { Dsl } from "./dsl";

const buildplan: Dsl = {
  id: "buildplan",
  name: { en: "build_plan · 1 subagent", de: "build_plan · 1 Subagent" },
  prompt: {
    en: 'Add a --version flag to the Java CLI "spectroscope". Plan it first with the build_plan tool (max 5 steps, do not write files), then show me the plan.',
    de: 'Füge der Java-CLI "spectroscope" ein --version-Flag hinzu. Plane es zuerst mit dem build_plan-Tool (max. 5 Schritte, keine Dateien schreiben), dann zeig mir den Plan.',
  },
  provider: "ollama",
  steps: [
    { think: { en: "The user wants a plan. I delegate it to a planner subagent via build_plan.", de: "Der User will einen Plan. Ich delegiere ihn an einen Planer-Subagenten via build_plan." } },
    { spawn: "worker-1", label: "build_plan",
      task: { en: "Plan how to add a --version flag. Max 5 steps, no files.", de: "Plane das Hinzufügen eines --version-Flags. Max. 5 Schritte, keine Dateien." },
      steps: [
        { think: { en: "First I load the 'writing-plans' skill.", de: "Zuerst lade ich die 'writing-plans'-Skill." } },
        { status: { en: "Reading task and existing files", de: "Aufgabe und vorhandene Dateien lesen" } },
        { say: { en: "# Plan: --version flag\n1. picocli @Option …", de: "# Plan: --version-Flag\n1. picocli @Option …" } },
      ] },
    { think: { en: "The plan is solid. I verify the current Main class.", de: "Der Plan ist solide. Ich prüfe die aktuelle Main-Klasse." } },
    { read: "spectro-cli/src/main/java/dev/spectroscope/cli/Main.java",
      result: { en: "public final class Main { … }", de: "public final class Main { … }" } },
    { run: "./gradlew test --quiet", gate: "allow",
      result: { en: "BUILD SUCCESSFUL in 12s\n42 tests, 0 failures", de: "BUILD SUCCESSFUL in 12s\n42 Tests, 0 Fehler" } },
    { mcp: "notes__search_notes", input: { query: "version flag conventions", limit: 5 }, gate: "deny" },
    { think: { en: "Even without the notes the plan is enough.", de: "Auch ohne die Notizen reicht der Plan." } },
    { say: { en: "Here is the finished 5-step plan for the --version flag …", de: "Hier ist der fertige 5-Schritte-Plan für das --version-Flag …" } },
  ],
};

const fanout: Dsl = {
  id: "fanout",
  name: { en: "Review fan-out · 3 subagents", de: "Review-Fan-out · 3 Subagenten" },
  prompt: {
    en: "Review the open PR thoroughly: bugs, performance and security. Check them in parallel, then summarize by priority.",
    de: "Prüfe den offenen PR gründlich: Bugs, Performance und Sicherheit. Prüfe parallel, dann fasse nach Priorität zusammen.",
  },
  provider: "ollama",
  steps: [
    { think: { en: "I fan out into three parallel reviewers.", de: "Ich fächere in drei parallele Reviewer auf." } },
    { fanout: { label: "review", tool: "review", agents: [
      { id: "bugs", task: { en: "Find bugs in the diff", de: "Finde Bugs im Diff" },
        steps: [{ think: { en: "I check null checks and bounds.", de: "Ich prüfe Null-Checks und Grenzen." } }, { status: { en: "checking null checks", de: "prüfe Null-Checks" } }, { say: { en: "## Bugs\n- Off-by-one in the pager.", de: "## Bugs\n- Off-by-one im Pager." } }] },
      { id: "perf", task: { en: "Check performance", de: "Prüfe Performance" },
        steps: [{ think: { en: "I look for N+1 queries.", de: "Ich suche N+1-Queries." } }, { status: { en: "checking queries", de: "prüfe Queries" } }, { say: { en: "## Performance\n- N+1 in ListRepo.findAll().", de: "## Performance\n- N+1 in ListRepo.findAll()." } }] },
      { id: "security", task: { en: "Check security", de: "Prüfe Sicherheit" },
        steps: [{ think: { en: "I check injection and secrets.", de: "Ich prüfe Injection und Secrets." } }, { read: "src/main/java/app/Db.java", result: 'String sql = "SELECT * FROM u WHERE id=" + id;' }, { status: { en: "checking injection", de: "prüfe Injection" } }, { say: { en: "## Security\n- SQL concat → injection.", de: "## Sicherheit\n- SQL-Concat → Injection." } }] },
    ] } },
    { think: { en: "All three reviews are back. I prioritize the security finding.", de: "Alle drei Reviews sind zurück. Ich priorisiere den Security-Fund." } },
    { say: { en: "Summary: 1 critical security finding, 1 bug, 1 performance issue …", de: "Zusammenfassung: 1 kritischer Security-Fund, 1 Bug, 1 Performance-Problem …" } },
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
    { think: { en: "Deleting is risky, that needs your approval.", de: "Löschen ist riskant, das braucht deine Freigabe." } },
    { run: "rm -rf data/tmp", gate: "deny" },
    { think: { en: "Denied. I delete nothing and only take a look.", de: "Abgelehnt. Ich lösche nichts und schaue nur." } },
    { list: "data/tmp", result: "cache.bin\nsession.log" },
    { run: "git status --short", gate: "allow", result: " M src/app.ts" },
    { say: { en: "I deleted nothing (denied). Git shows one changed file.", de: "Ich habe nichts gelöscht (abgelehnt). Git zeigt eine geänderte Datei." } },
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
    { say: { en: "Config updated (retries 3→5), src/ listed, tests green.", de: "Config aktualisiert (retries 3→5), src/ gelistet, Tests grün." } },
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
  name: { en: "Coding · 4 phases, parallel workers", de: "Coding · 4 Phasen, parallele Worker" },
  prompt: {
    en: "Add retry logic to the HTTP client and cover it with a test. Explore first, plan, implement in parallel, then verify.",
    de: "Füge dem HTTP-Client Retry-Logik hinzu und decke sie mit einem Test ab. Erst erkunden, dann planen, parallel implementieren, dann verifizieren.",
  },
  provider: "ollama",
  steps: [
    { think: { en: "Phase 1/4 — EXPLORE. I read the client and its test before touching anything.", de: "Phase 1/4 — ERKUNDEN. Ich lese den Client und seinen Test, bevor ich etwas anfasse." } },
    { read: "src/http/client.ts", result: "export async function get(url) { return fetch(url); } // no retries" },
    { read: "test/client.test.ts", result: "it('gets', …) // happy path only" },
    { think: { en: "Phase 2/4 — PLAN. A planner subagent drafts the steps.", de: "Phase 2/4 — PLANEN. Ein Planer-Subagent entwirft die Schritte." } },
    { spawn: "planner", label: "build_plan",
      task: { en: "Plan retry logic for get(): backoff, max 3 attempts, then a test.", de: "Plane Retry-Logik für get(): Backoff, max. 3 Versuche, dazu ein Test." },
      steps: [
        { think: { en: "Small surface: wrap fetch in a loop with exponential backoff.", de: "Kleine Fläche: fetch in eine Schleife mit exponentiellem Backoff wickeln." } },
        { status: { en: "drafting the 3-step plan", de: "entwerfe den 3-Schritte-Plan" } },
        { say: { en: "# Plan\n1. retry(fn, 3, backoff) helper\n2. use it in get()\n3. test: fails twice, succeeds third", de: "# Plan\n1. retry(fn, 3, backoff)-Helfer\n2. in get() verwenden\n3. Test: scheitert zweimal, klappt beim dritten" } },
      ] },
    { think: { en: "Phase 3/4 — IMPLEMENT. Two workers in parallel: code and test.", de: "Phase 3/4 — IMPLEMENTIEREN. Zwei Worker parallel: Code und Test." } },
    { fanout: { label: "develop", tool: "develop", agents: [
      { id: "impl", task: { en: "Implement retry() and wire it into get()", de: "retry() implementieren und in get() einbauen" },
        steps: [
          { think: { en: "Loop, await backoff, rethrow on the last attempt.", de: "Schleife, Backoff awaiten, beim letzten Versuch rethrown." } },
          { status: { en: "writing src/http/retry.ts", de: "schreibe src/http/retry.ts" } },
          { write: "src/http/retry.ts", result: "ok, wrote 1 file" },
          { say: { en: "retry() in place, get() now uses it.", de: "retry() steht, get() nutzt es jetzt." } },
        ] },
      { id: "tester", task: { en: "Write the failing-then-passing retry test", de: "Den erst-rot-dann-grün Retry-Test schreiben" },
        steps: [
          { think: { en: "Mock fetch: two rejections, then a 200.", de: "fetch mocken: zwei Rejections, dann ein 200." } },
          { status: { en: "writing test/retry.test.ts", de: "schreibe test/retry.test.ts" } },
          { write: "test/retry.test.ts", result: "ok, wrote 1 file" },
          { say: { en: "Test covers the backoff path.", de: "Der Test deckt den Backoff-Pfad ab." } },
        ] },
    ] } },
    { think: { en: "Phase 4/4 — VERIFY. Run the suite; shell needs your approval.", de: "Phase 4/4 — VERIFIZIEREN. Suite ausführen; die Shell braucht deine Freigabe." } },
    { run: "npm test", gate: "allow", result: "14 passed, 0 failed (2 new)" },
    { say: { en: "Done: retry with backoff shipped, covered by a test, suite green — explored, planned, built in parallel, verified.", de: "Fertig: Retry mit Backoff eingebaut, per Test abgedeckt, Suite grün — erkundet, geplant, parallel gebaut, verifiziert." } },
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
  name: { en: "Research · consolidate + critical review", de: "Research · Konsolidierung + kritisches Review" },
  prompt: {
    en: "Should we adopt HTTP/3 for our API edge? Research pros/cons, consolidate, and review the draft critically before answering.",
    de: "Sollten wir HTTP/3 für unsere API-Edge einführen? Recherchiere Pro/Contra, konsolidiere und reviewe den Entwurf kritisch, bevor du antwortest.",
  },
  provider: "ollama",
  steps: [
    { think: { en: "I sweep two sources in parallel, then merge before anything ships.", de: "Ich durchsuche zwei Quellen parallel und führe dann zusammen, bevor etwas rausgeht." } },
    { fanout: { label: "research", tool: "research", agents: [
      { id: "docs", task: { en: "Scan the IETF/QUIC docs for HTTP/3 trade-offs", de: "IETF/QUIC-Doku nach HTTP/3-Trade-offs durchsuchen" },
        steps: [
          { think: { en: "RFC 9114 and QUIC loss recovery are the core.", de: "RFC 9114 und QUIC Loss Recovery sind der Kern." } },
          { mcp: "docs__search", input: { query: "HTTP/3 QUIC head-of-line blocking" }, gate: "allow", result: "QUIC removes TCP HoL blocking; UDP path required" },
          { status: { en: "reading RFC notes", de: "lese RFC-Notizen" } },
          { say: { en: "Docs: no TCP head-of-line blocking, but UDP must be open end-to-end.", de: "Doku: kein TCP-Head-of-Line-Blocking, aber UDP muss Ende-zu-Ende offen sein." } },
        ] },
      { id: "web", task: { en: "Find real-world adoption reports", de: "Praxisberichte zur Einführung finden" },
        steps: [
          { think: { en: "Look for CDN and big-API adoption numbers.", de: "Nach CDN- und Big-API-Adoptionszahlen suchen." } },
          { mcp: "web__search", input: { query: "HTTP/3 production adoption report" }, gate: "allow", result: "major CDNs default to h3; some corp networks still block UDP/443" },
          { status: { en: "collecting adoption data", de: "sammle Adoptionsdaten" } },
          { say: { en: "Field reports: CDNs default to h3; corporate networks blocking UDP are the main regression risk.", de: "Praxis: CDNs defaulten auf h3; UDP-blockende Firmennetze sind das Hauptrisiko." } },
        ] },
    ] } },
    { think: { en: "CONSOLIDATE. Both sweeps agree on the upside; the risk is UDP reachability. Drafting.", de: "KONSOLIDIEREN. Beide Recherchen einig beim Nutzen; das Risiko ist UDP-Erreichbarkeit. Ich entwerfe." } },
    { say: { en: "Draft: adopt HTTP/3 at the edge with TCP fallback (Alt-Svc), because HoL blocking disappears and CDNs already default to it.", de: "Entwurf: HTTP/3 an der Edge einführen mit TCP-Fallback (Alt-Svc), weil HoL-Blocking verschwindet und CDNs es bereits defaulten." } },
    { spawn: "critic", label: "review",
      task: { en: "Challenge the draft: what breaks it? Check the fallback claim.", de: "Fordere den Entwurf heraus: Woran scheitert er? Prüfe die Fallback-Behauptung." },
      steps: [
        { think: { en: "The draft assumes Alt-Svc fallback is seamless — is it, on first connect?", de: "Der Entwurf nimmt an, der Alt-Svc-Fallback sei nahtlos — ist er das beim Erstkontakt?" } },
        { status: { en: "attacking the fallback assumption", de: "greife die Fallback-Annahme an" } },
        { say: { en: "CONTRADICTION: first connections are TCP anyway (Alt-Svc is learned), so 'seamless h3-first' overstates it. Also: measure UDP-blocked share before committing.", de: "WIDERSPRUCH: Erstverbindungen laufen ohnehin über TCP (Alt-Svc wird erst gelernt), 'nahtlos h3-first' übertreibt also. Außerdem: UDP-Block-Anteil messen, bevor wir uns festlegen." } },
      ] },
    { think: { en: "The critic is right — I verify the UDP-blocked share before finalizing.", de: "Der Kritiker hat recht — ich prüfe den UDP-Block-Anteil, bevor ich abschließe." } },
    { mcp: "web__search", input: { query: "share of clients with UDP 443 blocked" }, gate: "allow", result: "~3-5% of enterprise clients; consumer <1%" },
    { say: { en: "Final: adopt HTTP/3 at the edge. First contact stays TCP (Alt-Svc upgrade), ~3-5% enterprise clients stay on h2 — acceptable. Rollout with per-network fallback metrics.", de: "Final: HTTP/3 an der Edge einführen. Erstkontakt bleibt TCP (Alt-Svc-Upgrade), ~3–5 % Enterprise-Clients bleiben auf h2 — akzeptabel. Rollout mit Fallback-Metriken pro Netz." } },
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
    { think: { en: "Three long docs. Every read lands in my context window — watch the gauge.", de: "Drei lange Dokus. Jeder Read landet in meinem Context-Window — beobachte die Anzeige." } },
    { read: "docs/01-architecture.md", result: "(9,000 lines of architecture notes …)" },
    { say: { en: "Chapter 1 digested: the host, two bridges, one gateway VM.", de: "Kapitel 1 verdaut: der Host, zwei Bridges, eine Gateway-VM." } },
    CTX(26400),
    { think: { en: "A quarter full. Next document.", de: "Ein Viertel voll. Nächstes Dokument." } },
    { read: "docs/02-network-topology.md", result: "(12,000 lines: four nets, IP plan, WireGuard …)" },
    { say: { en: "Chapter 2 digested: four nets, the lab bridge is isolated.", de: "Kapitel 2 verdaut: vier Netze, die Lab-Bridge ist isoliert." } },
    CTX(63800),
    { think: { en: "Over 60% — the meter turns amber. One more read fits.", de: "Über 60 % — die Anzeige wird gelb. Ein Read passt noch." } },
    { read: "docs/08-rebuild-runbook.md", result: "(15,000 lines: the full rebuild runbook …)" },
    { say: { en: "Chapter 3 digested: the rebuild runbook, step by step.", de: "Kapitel 3 verdaut: das Rebuild-Runbook, Schritt für Schritt." } },
    CTX(87200),
    { think: { en: "87% — nearly full. The harness now COMPACTS: old turns become one summary.", de: "87 % — fast voll. Der Harness KOMPAKTIERT jetzt: alte Turns werden EINE Zusammenfassung." } },
    { compact: { removedTurns: 6, summaryChars: 3200 } },
    { think: { en: "The window is small again; the summary carries the essence forward.", de: "Das Fenster ist wieder klein; die Zusammenfassung trägt die Essenz weiter." } },
    { say: { en: "One summary of all three docs: a single host, four isolated nets, and a rebuild path — delivered on a freshly compacted window.", de: "Eine Zusammenfassung aller drei Dokus: ein Host, vier isolierte Netze und ein Rebuild-Pfad — geliefert auf frisch kompaktiertem Fenster." } },
  ],
};

export const SCENARIOS: Dsl[] = [buildplan, fanout, permission, diskshell, coding, research, context];
