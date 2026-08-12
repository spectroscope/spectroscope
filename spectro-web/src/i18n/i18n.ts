// UI-chrome localisation (DE/EN), ported from the LLM_Simulator's dict/t()
// pattern. Scope: CHROME ONLY — buttons, labels, tabs, dialogs. Chat content,
// tool payloads and the JSONL wire never run through here (a session has its
// own language). Pure module: no React, no storage.

export type Lang = "de" | "en";

export const dict: Record<string, { de: string; en: string }> = {
  // sidebar / navigation
  "nav.newChat": { de: "Neuer Chat", en: "New chat" },
  "nav.live": { de: "Live-Session", en: "Live session" },
  "nav.liveSub": { de: "dieser Browser-Tab", en: "this browser tab" },
  "nav.emptySession": { de: "(leere Session)", en: "(empty session)" },
  "nav.none": {
    de: "Noch keine gespeicherten Sessions. Beendete Läufe erscheinen hier.",
    en: "No stored sessions yet. Finished runs appear here.",
  },
  "nav.unreachable": {
    de: "Server nicht erreichbar · Session-Liste nicht verfügbar.",
    en: "Server unreachable · session list unavailable.",
  },
  "nav.importTitle": {
    de: "Eine .jsonl laden — spectroscope-Session oder Claude-Code-Transkript",
    en: "Load a .jsonl — spectroscope session or Claude Code transcript",
  },
  "nav.history": { de: "Verlauf", en: "History" },
  "nav.back": { de: "zurück (⌘←)", en: "back (⌘←)" },
  "nav.forward": { de: "vorwärts (⌘→)", en: "forward (⌘→)" },
  "nav.fleets": { de: "Flotten", en: "Fleets" },
  "nav.sessions": { de: "Sessions", en: "Sessions" },
  "nav.navMode": { de: "Sessions, Flotten oder State-Graph", en: "Sessions, fleets or state graph" },
  // What the circle in front of a row says, spelled out. Colour alone never
  // carries meaning here, and "unfinished" is deliberately not a synonym for
  // "running": a stored file with no run_end is not a process.
  "nav.run.running": { de: "läuft", en: "running" },
  "nav.run.live": { de: "verbunden", en: "connected" },
  "nav.run.open": { de: "nicht abgeschlossen", en: "unfinished" },
  "nav.run.idle": { de: "beendet", en: "finished" },
  "nav.stategraph": { de: "State-Graph", en: "State graph" },
  "nav.stategraphNote": {
    de: "Ein State-Graph liegt als Dateipaar neben der Session, nicht auf dem Server — lade ihn rechts in der Ansicht.",
    en: "A state graph sits beside the session as a pair of files, not on the server — load it in the view on the right.",
  },
  "nav.noFleets": {
    de: "Keine laufenden Flotten. Starte Nodes gegen den Hub, dann erscheinen sie hier.",
    en: "No running fleets. Start nodes against the hub and they appear here.",
  },
  "nav.scenarios": { de: "Szenarien", en: "Scenarios" },
  "nav.starters": { de: "Starter", en: "Starters" },
  "nav.startersTitle": {
    de: "Fertige Starter-Projekte (Gradle/Maven) kopieren oder in einen Ordner schreiben",
    en: "Ready-made starter projects (Gradle/Maven) to copy or scaffold into a folder",
  },
  "starter.kicker": { de: "starter", en: "starters" },
  "starter.title": { de: "Ein Projekt starten", en: "Start a project" },
  "starter.hint": {
    de: "Fertige Projekte gegen spectroscope — kopieren oder in einen Ordner schreiben",
    en: "Ready-made projects against spectroscope — copy the files or scaffold them into a folder",
  },
  "starter.loading": { de: "Lade Bundles …", en: "Loading bundles …" },
  "starter.copyAll": { de: "alle kopieren", en: "copy all" },
  "starter.scaffold": { de: "in ordner schreiben …", en: "scaffold into a folder …" },
  "starter.wrote": { de: "{n} Dateien geschrieben nach {dir}", en: "wrote {n} files into {dir}" },
  "starter.conflict": {
    de: "Nichts geschrieben — es existieren schon: {files}",
    en: "Nothing written — these already exist: {files}",
  },
  "starter.pickCancelled": { de: "Ordner-Auswahl abgebrochen.", en: "Folder pick cancelled." },
  "starter.pickFailed": { de: "Der Ordner-Dialog ist fehlgeschlagen.", en: "The folder dialog failed." },
  "nav.scenariosTitle": {
    de: "Skriptgesteuerte Demo-Läufe abspielen — deterministisch, ohne LLM und ohne API-Key",
    en: "Play scripted demo runs — deterministic, no LLM, no API key",
  },

  // session rows: the glyph's channels in words (hover), and the folded piles
  "sess.agent": { de: "{n} Agent", en: "{n} agent" },
  "sess.agents": { de: "{n} Agenten", en: "{n} agents" },
  "sess.turn": { de: "{n} Turn", en: "{n} turn" },
  "sess.turns": { de: "{n} Turns", en: "{n} turns" },
  "sess.token": { de: "{n} Token", en: "{n} token" },
  "sess.tokens": { de: "{n} Tokens", en: "{n} tokens" },
  "sess.ranFor": { de: "Dauer {d}", en: "ran for {d}" },
  "sess.out.clean": { de: "sauber beendet", en: "finished cleanly" },
  // The raw stop reason rides along: the wire has words this edition does not
  // interpret, and inventing a reading for them would be the wrong kind of tidy.
  "sess.out.cut": { de: "vorzeitig gestoppt ({r})", en: "stopped short ({r})" },
  "sess.out.failed": { de: "mit einem Fehler beendet", en: "ended in an error" },
  "sess.out.open": { de: "kein run_end aufgezeichnet", en: "no run_end recorded" },
  "sess.gateAsked": { de: "Gate: {n}× gefragt, alle erlaubt", en: "gate: asked {n}×, all allowed" },
  "sess.gateDenied": { de: "Gate: {n}× gefragt, {d}× verweigert", en: "gate: asked {n}×, refused {d}×" },
  // The pile is gone (the list is flat now), and so are the two strings that
  // described it. `sess.pile` had already lost its last caller before that.

  // header
  "hdr.archive": { de: "Archiv", en: "Archive" },
  "hdr.scenario": { de: "Szenario", en: "Scenario" },
  "hdr.newSession": { de: "Neue Session", en: "New session" },
  "hdr.archivedSession": { de: "Archivierte Session", en: "Archived session" },
  "hdr.sidebarHide": { de: "Sidebar ausblenden", en: "Hide sidebar" },
  "hdr.sidebarShow": { de: "Sidebar einblenden", en: "Show sidebar" },
  "hdr.panelToggle": { de: "Agenten & Kontext anzeigen", en: "Show agents & context" },
  "hdr.panelHide": { de: "Panel ausblenden", en: "Hide panel" },
  "hdr.langTitle": {
    de: "Sprache der Oberfläche: Deutsch (klick für Englisch)",
    en: "UI language: English (click for German)",
  },

  // scenario dialog
  "scn.title": { de: "Szenario abspielen", en: "Play a scenario" },
  "scn.hint": {
    de: "Skriptgesteuerte Demo-Läufe — deterministisch kompiliert, ganz ohne LLM. Ein Chat-Lauf öffnet im Lab (Schritt für Schritt oder im Flow-Modus); ein Fleet-Lauf öffnet die Fleet-Ansicht, wo du die Topologie inspizierst.",
    en: "Scripted demo runs — deterministically compiled, no LLM involved. A chat run opens in the Lab (step through it, or auto-play in flow mode); a fleet run opens the fleet view, where you inspect the topology.",
  },
  "scn.tab.chats": { de: "chats / agenten", en: "chats / agents" },
  "scn.tab.fleet": { de: "fleet", en: "fleet" },
  "scn.empty.fleet": { de: "Keine Fleet-Szenarien.", en: "No fleet scenarios." },

  // import dialog
  "imp.title": { de: "Session-Datei laden", en: "Load a session file" },
  "imp.hint": {
    de: "Rohes spectroscope-JSONL wird wortwörtlich abgespielt; ein Claude-Code-Transkript ({path}) wird adaptiert — Subagenten-Sidechains werden Kind-Agenten.",
    en: "Raw spectroscope JSONL replays verbatim; a Claude Code transcript ({path}) is adapted — subagent sidechains become child agents.",
  },
  "imp.placeholder": { de: ".jsonl-Inhalt hier einfügen …", en: "Paste .jsonl content here …" },
  "imp.store": {
    de: "Direkt aus ~/.claude/projects (im Finder unsichtbar) — ein Klick lädt:",
    en: "Straight from ~/.claude/projects (invisible in Finder) — one click loads:",
  },
  "imp.truncated": {
    de: "… nur die {n} neuesten. Ältere Transkripte liegen im Store, stehen aber nicht in dieser Liste.",
    en: "… the {n} newest only. Older transcripts are in the store but not in this list.",
  },
  "imp.pick": { de: "Datei wählen …", en: "Pick a file …" },
  "imp.vscodeNote": {
    de: "Dieser VS-Code-Export hält fest, welche Tools liefen und ob sie erfolgreich waren, aber nicht, was sie zurückgaben. Die Tool-Inhalte bleiben deshalb leer.",
    en: "This VS Code export records which tools ran and whether they succeeded, but not what they returned. The tool bodies are empty for that reason.",
  },
  "imp.err.read": {
    de: "Der Browser konnte „{name}“ nicht lesen. Liegt die Datei noch da, und darf er sie sehen?",
    en: "Could not read \u201C{name}\u201D. Is the file still there, and may the browser see it?",
  },
  "imp.err.fetch": {
    de: "Der Server gab {status} zurück, als er die Datei holen sollte.",
    en: "The server answered {status} when asked for that file.",
  },
  "imp.load": { de: "Laden", en: "Load" },
  // The full-screen dialog's filter and statistics line. The chips carry wire
  // vocabulary — the lowercase words the data itself uses — so they read the
  // same in both languages on purpose; the labels around them translate.
  "imp.gist.run": { de: "{n} zusammenfassen", en: "summarise {n}" },
  "imp.gist.runWhat": {
    de: "Fragt das eingestellte Modell, worum es in den angezeigten Sessions ging, die noch keine Zeile haben. Kostet einen Aufruf je Session; das Ergebnis bleibt gespeichert.",
    en: "Asks the configured model what the shown sessions were about, for the ones with no line yet. One call per session; the answer is kept.",
  },
  "imp.gist.all": { de: "alle neu", en: "all again" },
  "imp.gist.allWhat": {
    de: "Verwirft alle gespeicherten Zeilen und schreibt sie neu — für ein anderes Modell.",
    en: "Throws away every stored line and writes them again — for a different model.",
  },
  "imp.gist.working": { de: "läuft …", en: "working …" },
  "imp.gist.wrote": { de: "{n} geschrieben", en: "{n} written" },
  "imp.filter.text": {
    de: "tippen zum Filtern — Datei, Projekt, Modell, Prompt",
    en: "type to filter — file, project, model, prompt",
  },
  "imp.filter.model": { de: "modell", en: "model" },
  "imp.filter.with": { de: "mit", en: "with" },
  "imp.chip.workflow": { de: "workflow", en: "workflow" },
  "imp.chip.subagents": { de: "subagents", en: "subagents" },
  "imp.chip.images": { de: "Bilder", en: "images" },
  "imp.stats.transcripts": { de: "{n} Transkripte", en: "{n} transcripts" },
  "imp.stats.workflow": { de: "workflow-Aufrufe {n}", en: "workflow calls {n}" },
  "imp.stats.subagents": { de: "Subagenten {n}", en: "subagents {n}" },
  "imp.stats.workflowAgents": { de: "Workflow-Agenten {n}", en: "workflow agents {n}" },
  "imp.stats.images": { de: "Bilder {n}", en: "images {n}" },
  // Card 179 follow-up: the three folders a recorded session left on disk. The
  // store hides under a dot-folder and the scratchpad under a temp path nobody
  // would guess, so the app could read these files and never show them.
  "folder.transcript": { de: "Ordner", en: "folder" },
  "folder.workflows": { de: "Workflows", en: "workflows" },
  "folder.scratchpad": { de: "Scratchpad", en: "scratchpad" },
  "folder.failed": { de: "ging nicht auf", en: "did not open" },
  // The lightbox for pictures a transcript CARRIED. Its own `shot.*` namespace
  // rather than `img.*`, which already belongs to the generated-image panel —
  // two different things that would otherwise share a key and silently win
  // over each other by file order.
  // "folder" is deliberately the TRANSCRIPT's folder: the picture
  // is base64 inside the .jsonl and is not a file on disk, so there is no
  // folder it lies in. Saying otherwise on a button would be a small lie.
  "shot.title": { de: "Bild", en: "picture" },
  "shot.fromMessage": { de: "aus einer Nachricht", en: "from a message" },
  "shot.fromTool": { de: "von {tool}", en: "from {tool}" },
  "shot.save": { de: "speichern", en: "save" },
  "shot.saved": { de: "gespeichert", en: "saved" },
  "shot.folder": { de: "Ordner", en: "folder" },
  "shot.folderTitle": {
    de: "Zeigt den Ordner des TRANSKRIPTS. Das Bild selbst ist keine Datei auf der Platte — es steckt als base64 in der .jsonl.",
    en: "Shows the TRANSCRIPT's folder. The picture itself is not a file on disk — it is base64 inside the .jsonl.",
  },
  "shot.close": { de: "schließen", en: "close" },
  "shot.prev": { de: "vorheriges Bild", en: "previous picture" },
  "shot.next": { de: "nächstes Bild", en: "next picture" },
  "shot.keys": { de: "← → blättern · Esc schließt", en: "← → to walk · Esc closes" },
  // The three faces. The owner asked to see the base64 AND the file it sits in,
  // once he learned the picture is not a file: "wäre cool einen schalter zu
  // haben das base64 jpeg zu sehen und eben DIE DATEI, wo der string drinne
  // steht … WO genau in der datei mit highlight das steht".
  "shot.faces": { de: "Ansicht", en: "face" },
  "shot.face.picture": { de: "Bild", en: "picture" },
  "shot.face.base64": { de: "base64", en: "base64" },
  "shot.face.file": { de: "Datei", en: "file" },
  "shot.base64Head": { de: "{media} · {chars} Zeichen", en: "{media} · {chars} characters" },
  "shot.copy": { de: "kopieren", en: "copy" },
  "shot.copied": { de: "kopiert", en: "copied" },
  "shot.fileHead": { de: "Zeile {line} von {total}", en: "line {line} of {total}" },
  // A record often carries several pictures — the owner's own opening one has
  // four — and saying so is what explains the extra blob marks on the line.
  "shot.fileHeadN": {
    de: "Zeile {line} von {total} · dieser eine Record trägt {n} Bilder",
    en: "line {line} of {total} · this one record carries {n} pictures",
  },
  "shot.fileUnknown": {
    de: "Diese Zeile trägt keinen base64-Block — die Datei sagt nicht, woher das Bild kam.",
    en: "That line carries no base64 block — the file does not say where this picture came from.",
  },
  "shot.blob": { de: "◀ {chars} Zeichen base64 ▶", en: "◀ {chars} characters of base64 ▶" },
  "shot.blobTitle": {
    de: "Hier steht das Bild. Klick zeigt den String selbst.",
    en: "This is where the picture is. Click to see the string itself.",
  },
  "folder.failedTitle": {
    de: "Der Ordner ist weg, oder diese Maschine hat keinen Dateimanager, den wir kennen.",
    en: "The folder is gone, or this machine has no file manager we know.",
  },
  "imp.stats.unread": { de: "{n} noch ungelesen", en: "{n} not read yet" },
  "imp.pendingNote": {
    de: "{n} Transkripte sind noch nicht gelesen — sie erscheinen hier, sobald ihre Fakten da sind.",
    en: "{n} transcripts not read yet — they appear here as their facts arrive.",
  },
  "imp.close": { de: "Schließen", en: "Close" },
  // Shown for EVERY import, not only the VS Code one. The counts are the file's
  // own: how many lines arrived, how many frames this view is built from, and
  // how many lines hold no part of the conversation (the pointer records a
  // client keeps, the session name, the editing mode). The last sentence is the
  // plain truth about where the file lives: an import is never written to disk,
  // and cannot be resumed or deleted.
  //
  // The sentence used to end "produced no frame", which reads as loss and sent
  // the owner looking for a parsing bug that was not there (card 141). The
  // number is smaller now as well, because four of the kinds it counted became
  // frames; what is left really does carry nothing.
  // Card 152 corrected the last of it. "110 lines carry no conversation" is a
  // claim about the FILE, and on a subagent transcript it was flatly false: all
  // 110 of those lines held a conversation, and the importer could not
  // attribute them. The number is a measurement of what this importer read, so
  // the sentence says that instead. What the reader does with it is the same
  // either way; what it no longer does is describe somebody else's file as
  // empty.
  "imp.bar": {
    de: "Importiert aus {file}. {lines} Zeilen, {frames} Frames, aus {zero} Zeilen wurde nichts gelesen. Nichts wurde auf die Platte geschrieben.",
    en: "Imported from {file}. {lines} lines, {frames} frames, nothing read from {zero} of them. Nothing was written to disk.",
  },
  // What a standalone subagent transcript is, said in three clauses so that a
  // file which names only its agent says only that. See importBar.ts.
  "imp.subagent": {
    de: "Das ist das Transkript eines Subagenten, keine Sitzung: Agent {agent}.",
    en: "This is a subagent transcript, not a session: agent {agent}.",
  },
  "imp.subagentKind": { de: "Art: {kind}.", en: "Kind: {kind}." },
  "imp.subagentSession": { de: "Er lief in Sitzung {session}.", en: "It ran in session {session}." },

  // common
  "common.cancel": { de: "Abbrechen", en: "Cancel" },
  "common.close": { de: "Schließen", en: "Close" },
  "common.copyAll": { de: "Alles kopieren", en: "Copy all" },

  // graph view (replay bar + detail panel)
  "gv.full": { de: "Alles", en: "Full" },
  "gv.lapse": { de: "Zeitraffer", en: "Time-lapse" },
  "gv.pause": { de: "Pause", en: "Pause" },
  "gv.events": { de: "{n}/{total} Events", en: "{n}/{total} events" },
  "gv.started": { de: "gestartet {t}", en: "started {t}" },
  "gv.omitted": { de: "… {n} weitere Text-Deltas ausgelassen", en: "… {n} more text deltas omitted" },

  // trace agent chips (Spectrum -> Trace hand-off)
  "trace.agentsAria": { de: "Nach Agent filtern", en: "Filter by agent" },
  "trace.allAgents": { de: "alle Agenten", en: "all agents" },

  // reasoning lens (card 13) — honest labeling: the model's self-report
  "trace.lens": { de: "reasoning lens", en: "reasoning lens" },
  "trace.lensTitle": {
    de: "Denk-Events hervorheben, alles andere abblenden. Tool-Calls und Gates bleiben als Anker lesbar.",
    en: "Foreground thinking events, dim the rest. Tool calls and gates stay readable as anchors.",
  },
  "trace.timeline": { de: "timeline", en: "timeline" },
  "trace.otel": { de: "otel", en: "otel" },
  "trace.modelCol": { de: "modell", en: "model" },
  // card 137: the deep link, shown only once spans actually landed
  "trace.langfuse": { de: "open in langfuse", en: "open in langfuse" },
  "trace.langfuseTitle": {
    de: "Diese Session als Trace in Langfuse öffnen. Die Trace-ID wird aus der Session-ID berechnet, genau wie beim Export.",
    en: "Open this session as a trace in Langfuse. The trace id is computed from the session id, the same way the export computes it.",
  },
  "trace.otlpFailed": { de: "otlp-export fehlgeschlagen", en: "otlp export failed" },
  "trace.otelTitle": {
    de: "OTel-Exporte zeigen — jedes Paket, das an den konfigurierten OTLP-Endpoint (z. B. Langfuse) geht",
    en: "Show OTel exports — every batch posted to the configured OTLP endpoint (e.g. Langfuse)",
  },
  "trace.timelineTitle": {
    de: "Jede Zeile trägt ihre Wartezeit als Balken (log-skaliert, damit ein Ausreißer den Rest nicht plättet) — wohin die Zeit ging, auf einen Blick. Δt bleibt die lineare Wahrheit.",
    en: "Each row wears its wait as a bar (log-scaled so one outlier cannot flatten the rest) — where the time went, at a glance. Δt stays the linear truth.",
  },
  "trace.lensNote": {
    de: "Reasoning ist der Selbstbericht des Modells, aufgezeichnet neben dem, was es dann tat. Kein Fenster in die Gewichte.",
    en: "Reasoning is the model's self-report, recorded next to what it then did. Not a window into the weights.",
  },
  "trace.lensNone": {
    de: "Keine Reasoning-Events in diesem Stream. Entweder ist die Aufzeichnung aus (Thinking-Schalter) oder das Modell hat keine gesendet.",
    en: "No reasoning events in this stream. Either capture is off (thinking toggle) or the model sent none.",
  },
  "trace.pairThen": { de: "danach:", en: "then:" },
  "trace.pairFrom": { de: "daraus:", en: "after:" },
  "trace.pairFromTitle": {
    de: "Zum Reasoning springen, das lief, als dieser Schritt passierte.",
    en: "Jump to the reasoning that was in charge when this step ran.",
  },
  "trace.reasonBlock": { de: "reasoning", en: "reasoning" },
  "trace.pairJump": {
    de: "Zur Aktion springen, die auf diesen Denk-Block folgte",
    en: "Jump to the action that followed this thinking block",
  },

  // causal chain (spectro-explain, deterministic)
  "trace.chain": { de: "kette", en: "chain" },
  "trace.chainAria": {
    de: "Kausalkette dieses Frames, zurück bis zum Prompt",
    en: "This frame's causal chain, back to the prompt",
  },

  // replay scrubber
  "trace.scrub": { de: "replay", en: "replay" },
  "trace.scrubAria": { de: "Stream bis zu diesem Frame zeigen", en: "Show the stream up to this frame" },
  "trace.scrubLive": { de: "Ende", en: "end" },
  "trace.scrubAt": { de: "Frame {n} / {t}", en: "frame {n} / {t}" },
  "trace.scrubReset": { de: "ans Ende", en: "to the end" },

  // gate surface (first-class permission bar)
  "gate.aria": { de: "Permission-Gate", en: "Permission gate" },
  "gate.kicker": { de: "gate", en: "gate" },
  "gate.queue": { de: "+{n} wartend", en: "+{n} waiting" },
  "gate.remember": { de: "immer erlauben (Session)", en: "always allow (session)" },
  "gate.persist": { de: "im Projekt speichern", en: "save to project" },
  "gate.deny": { de: "Ablehnen", en: "Deny" },
  "gate.allow": { de: "Erlauben", en: "Allow" },
  "gate.expandAria": {
    de: "Vollen Input und aufgezeichnete Entscheidungen zeigen",
    en: "Show the full input and recorded outcomes",
  },
  "gate.collapse": { de: "Einklappen", en: "Collapse" },
  "gate.recorded": { de: "aufgezeichnet", en: "recorded" },
  "gate.histAllowed": { de: "erlaubt", en: "allowed" },
  "gate.histDenied": { de: "abgelehnt", en: "denied" },

  // explain panel (the why layer)
  "explain.toggle": { de: "gates", en: "gates" },
  "explain.toggleTitle": {
    de: "Die Gate-Why-Ladder: Lauf-Zusammenfassung + warum jedes Gate fragte, deterministisch aus dem Stream",
    en: "The gate why-ladder: run summary + why each gate asked, deterministic from the stream",
  },
  "explain.aria": { de: "Explain-Panel", en: "Explain panel" },
  "explain.kicker": { de: "the gate why-ladder", en: "the gate why-ladder" },
  "explain.empty": {
    de: "Noch kein Lauf aufgezeichnet. Das Panel faltet seine Fakten aus dem Stream.",
    en: "No run recorded yet. The panel folds its facts from the stream.",
  },
  "explain.summary": { de: "Lauf-Zusammenfassung", en: "run summary" },
  "explain.duration": { de: "Dauer", en: "duration" },
  "explain.agents": { de: "Agenten", en: "agents" },
  "explain.turns": { de: "Turns", en: "turns" },
  "explain.tools": { de: "Tool-Calls", en: "tool calls" },
  "explain.toolErrors": { de: "{n} Fehler", en: "{n} errors" },
  "explain.gates": { de: "Gates", en: "gates" },
  "explain.gatesLine": {
    de: "{asked} gefragt · {ok} erlaubt · {no} abgelehnt",
    en: "{asked} asked · {ok} allowed · {no} denied",
  },
  "explain.gatesPending": { de: "{n} offen", en: "{n} pending" },
  "explain.tokens": { de: "Tokens", en: "tokens" },
  "explain.errors": { de: "Fehler", en: "errors" },
  "explain.stop": { de: "Stop-Grund", en: "stop reason" },
  "explain.whyGates": { de: "warum hat das Gate gefragt", en: "why did the gate ask" },
  "explain.noGates": { de: "Kein Gate hat in diesem Lauf gefragt.", en: "No gate asked in this run." },
  "explain.jump": { de: "Zum Request-Frame springen", en: "Jump to the request frame" },
  "explain.outcome.pending": { de: "offen", en: "pending" },
  "explain.outcome.allowed": { de: "erlaubt", en: "allowed" },
  "explain.outcome.denied": { de: "abgelehnt", en: "denied" },
  "explain.why.ask": {
    de: "Modus ask: jedes Tool mit Seiteneffekten pausiert für eine Entscheidung. {name} gehört dazu.",
    en: "Mode ask: every side-effecting tool pauses for a decision. {name} is one of them.",
  },
  "explain.why.auto": {
    de: "Modus auto war aktiv, der Server hat diesen Call trotzdem pausiert — eine Regel oder ein Server-Default verlangte die Entscheidung.",
    en: "Mode auto was active, yet the server paused this call — a rule or a server default demanded the decision.",
  },
  "explain.why.readonly": {
    de: "Modus readonly: schreibende Tools pausieren. {name} zählt als schreibend.",
    en: "Mode readonly: writing tools pause. {name} counts as writing.",
  },
  "explain.why.unknown": {
    de: "Der Modus zur Frage-Zeit steckt nicht in diesem Stream (gespeicherte Sessions tragen keine Modus-Frames). Der Server-Default ist ask.",
    en: "The mode at ask time is not in this stream (stored sessions carry no mode frames). The server default is ask.",
  },
  "explain.note": {
    de: "Alle Angaben deterministisch aus dem aufgezeichneten Stream gefaltet. Reasoning-Text bleibt der Selbstbericht des Modells.",
    en: "Everything here is folded deterministically from the recorded stream. Reasoning text stays the model's self-report.",
  },

  // doctor (calibration/status page)
  "hdr.doctor": { de: "spectro doctor — Status & Kalibrierung", en: "spectro doctor — status & calibration" },
  "doc.title": { de: "spectro doctor", en: "spectro doctor" },
  "doc.kicker": { de: "calibration", en: "calibration" },
  "doc.lede": {
    de: "Eine gemessene Zeile pro Subsystem, aus Sicht dieses Browsers. Die Maschinen-Seite prüft das CLI.",
    en: "One measured line per subsystem, from this browser's viewpoint. The machine side is the CLI's job.",
  },
  "doc.api": { de: "Server-API", en: "server api" },
  "doc.socket": { de: "Live-Socket", en: "live socket" },
  "doc.socket.open": { de: "offen", en: "open" },
  "doc.socket.connecting": { de: "verbindet …", en: "connecting…" },
  "doc.socket.closed": { de: "getrennt", en: "closed" },
  "doc.backend": { de: "LLM-Backend", en: "llm backend" },
  "doc.backendNone": {
    de: "noch nicht angekündigt (provider_info fehlt)",
    en: "not announced yet (no provider_info)",
  },
  "doc.sessions": { de: "Session-Speicher", en: "session store" },
  "doc.sessionsN": { de: "{n} gespeicherte Sessions", en: "{n} stored sessions" },
  "doc.workspace": { de: "Standard-Workspace", en: "default workspace" },
  "doc.wsTemp": { de: "Temp-Ordner je Session", en: "per-session temp folder" },
  "doc.logging": { de: "Log-Level", en: "log level" },
  "doc.mode": { de: "Permission-Modus", en: "permission mode" },
  "doc.unreachable": { de: "nicht erreichbar", en: "unreachable" },
  "doc.healthy": { de: "alle Linien ruhig", en: "all lines steady" },
  "doc.unhealthy": { de: "eine Linie schlägt aus", en: "one line is off" },
  "doc.cliHint": {
    de: "Das CLI prüft zusätzlich Java, Konfig-Dateien und Provider-Erreichbarkeit von der Maschine aus.",
    en: "The CLI additionally checks Java, config files and provider reachability from the machine.",
  },
  "doc.logBoth": { de: "Log (Server + Browser)", en: "Log (server + browser)" },
  "doc.log": { de: "Server-Log", en: "server log" },
  "doc.logEmpty": { de: "noch kein Log", en: "no log yet" },
  "doc.logFull": { de: "Vollbild", en: "fullscreen" },

  // spectrum tab (fleet lanes)
  "sp.count": { de: "{n} Events · {lanes} Lanes", en: "{n} events · {lanes} lanes" },
  "sp.live": { de: "live", en: "live" },
  "sp.empty": {
    de: "Noch keine Lanes. Jeder Agent zeichnet eine Linie, sobald er läuft.",
    en: "No lanes yet. Every agent draws a line once it runs.",
  },
  "sp.emptyHint": {
    de: "Starte einen Lauf, öffne eine gespeicherte Session oder spiele ein Szenario ab.",
    en: "Start a run, open a stored session, or play a scenario.",
  },
  "sp.openTrace": { de: "Lane {id} im Trace öffnen", en: "Open lane {id} in the trace" },
  "sp.gateOpen": { de: "gate offen", en: "gate open" },
  "sp.noTask": { de: "(kein Task angekündigt)", en: "(no task announced)" },
  // What THIS view hides, counted against what is visible rather than against
  // the whole stream: on a sparse stretch the number falls to zero and the line
  // stops rendering; on a pile of marks that share one instant it stays put,
  // because no magnification can separate them.
  "sp.hiddenMark": {
    de: "{n} Marke passt hier nicht neben die anderen: die JSONL-Datei behält alles.",
    en: "{n} mark does not fit beside the others here: the JSONL file keeps everything.",
  },
  "sp.hiddenMarks": {
    de: "{n} Marken passen hier nicht neben die anderen: die JSONL-Datei behält alles.",
    en: "{n} marks do not fit beside the others here: the JSONL file keeps everything.",
  },
  "sp.legendAria": { de: "Legende der Event-Typen", en: "Event type legend" },
  "sp.lanesAria": { de: "Agenten-Lanes", en: "Agent lanes" },
  "sp.bandAria": {
    de: "Events von {id}: Pfeiltasten zum Scrubben, Enter öffnet im Trace",
    en: "{id} events: arrow keys to scrub, Enter to open in the trace",
  },
  // The viewport. These only ever render for a stream that cannot be drawn whole,
  // which is a small minority of sessions, so they explain the keys rather than
  // assuming a reader has met them before.
  "sp.stripAria": {
    de: "Überblick über die gesamte Zeitachse; Ziehen verschiebt das Fenster",
    en: "Overview of the whole time axis; drag to move the window",
  },
  "sp.axisAria": { de: "Zeitachse des sichtbaren Fensters", en: "Time axis of the visible window" },
  "sp.ofSpan": { de: "im Fenster", en: "in view" },
  "sp.overview": { de: "überblick", en: "overview" },
  "sp.zoomHint": {
    de: "Zoomen: ctrl + Mausrad oder + und −. Verschieben: Umschalt + Pfeiltasten, [ und ] springen über leere Achse. 0 zeigt wieder alles.",
    en: "Zoom: ctrl + wheel, or + and −. Pan: shift + arrows, and [ and ] page across empty axis. 0 shows everything again.",
  },
  // The zoom controls. Every one of them carries words, not just a glyph: a bare
  // "+" is unreadable to a screen reader and ambiguous next to a token count.
  "sp.zoomControlsAria": { de: "Zoom", en: "Zoom" },
  "sp.zoomIn": { de: "Näher heran (Taste +)", en: "Zoom in (key +)" },
  "sp.zoomOut": { de: "Weiter weg (Taste −)", en: "Zoom out (key −)" },
  "sp.zoomFit": { de: "Alles zeigen (Taste 0)", en: "Show everything (key 0)" },
  "sp.zoomFitShort": { de: "alles", en: "all" },
  // Why a control is off. A disabled button with no reason is the same dead end
  // as a live one that does nothing; these say which limit was reached.
  "sp.zoomAtFloor": { de: "Feinste Stufe erreicht: eine Sekunde", en: "Finest step reached: one second" },
  "sp.zoomAtWhole": { de: "Es ist bereits alles zu sehen", en: "Everything is already in view" },

  // fleet roster (Spectrum LIVE)
  "fleet.title": { de: "Flotte", en: "Fleet" },
  "fleet.count": { de: "{n} Knoten · {online} online", en: "{n} nodes · {online} online" },
  "fleet.rosterAria": { de: "Flotten-Roster", en: "Fleet roster" },
  "fleet.online": { de: "online", en: "online" },
  "fleet.offline": { de: "offline", en: "offline" },
  "fleet.epoch": { de: "Epoche {n}", en: "epoch {n}" },
  "fleet.restarted": {
    de: "neugestartet: neue Prozess-Inkarnation",
    en: "restarted: a new process incarnation",
  },
  "fleet.lastSeen": { de: "vor {t} gesehen", en: "seen {t} ago" },
  "fleet.noEvents": {
    de: "Noch keine Flotten-Events. Die Knoten sind da, ihre Linien erscheinen, sobald sie laufen.",
    en: "No fleet events yet. The nodes are here; their lines appear once they run.",
  },
  "fleet.modeAria": { de: "Graph-Lesart", en: "Graph reading" },
  "fleet.mode.aggregated": { de: "gruppiert", en: "aggregated" },
  "fleet.mode.aggregated.title": {
    de: "Gleiche Rollen zu Gruppen falten — Struktur auf einen Blick",
    en: "Fold same-role siblings into groups — structure at a glance",
  },
  "fleet.mode.expanded": { de: "einzeln", en: "expanded" },
  "fleet.mode.expanded.title": {
    de: "Jeden Agenten als eigenen Knoten zeigen — einem Lauf folgen",
    en: "Show every agent as its own node — follow one specific run",
  },
  "fleet.noEventsHint": {
    de: "Jeder Knoten zeichnet seine Spektrallinie, sobald er Events sendet.",
    en: "Each node draws its spectral line as soon as it emits events.",
  },

  // the bus view (0.7 ESB prototype)
  "bus.openAgent": { de: "diesen Agenten öffnen", en: "open this agent" },
  "bus.spawnedBy": { de: "gespawnt von", en: "spawned by" },
  "bus.gatePending": { de: "Gate wartet auf eine Entscheidung", en: "gate waiting for a decision" },
  "bus.openTrace": { de: "im Trace öffnen", en: "open in trace" },
  "bus.inlineOs": { de: "Inline-OS", en: "inline OS" },
  "bus.stopNode": { de: "diesen Knoten stoppen", en: "stop this node" },
  "bus.composerPlaceholder": { de: "Nachricht an diesen Agenten …", en: "message this agent …" },
  "bus.composerNoTrigger": {
    de: "Dieser Node kann keine Nachrichten annehmen — er hat keinen Trigger und damit keine Lauf-Schleife. Mit einem Trigger starten, dann geht es",
    en: "this node cannot take messages — it has no trigger, so it has no run loop. Start it with a trigger to talk to it",
  },
  "bus.composerOffline": { de: "Node ist nicht verbunden", en: "the node is not connected" },
  "bus.composerSend": { de: "Senden (Enter)", en: "send (Enter)" },
  "bus.messageSent": { de: "gesendet — best-effort, ohne Bestätigung", en: "sent — best-effort, no ack" },
  "bus.messageRefused": { de: "Node kann das nicht annehmen", en: "the node cannot take that" },
  "bus.messageGone": { de: "Node ist nicht mehr da", en: "the node is gone" },
  "bus.messageFailed": { de: "nicht gesendet", en: "not sent" },
  "bus.empty": { de: "Noch keine Knoten am Bus.", en: "No nodes on the bus yet." },
  "bus.spawnNode": { de: "+ Node andocken", en: "+ dock a node" },
  "bus.barAria": { de: "Flotten-Leiste", en: "Fleet bar" },
  "bus.feedEmpty": { de: "Noch keine Aktivität von diesem Agenten.", en: "No activity from this agent yet." },

  // permission dialog
  "perm.wants": { de: "möchte ausführen", en: "wants to execute" },
  "perm.by": { de: "angefragt von {id}", en: "requested by {id}" },
  "perm.queue": { de: "{i} von {n}", en: "{i} of {n}" },
  "perm.always": { de: "Immer erlauben:", en: "Always allow:" },
  "perm.session": { de: "(diese Session)", en: "(this session)" },
  "perm.persist": {
    de: "Dauerhaft (Projekt-Settings, .spectro/settings.json)",
    en: "Persist (project settings, .spectro/settings.json)",
  },
  "perm.noPersistHint": {
    de: "Dauerhaft speichern braucht einen echten Workspace.",
    en: "Persisting for good needs a real workspace.",
  },
  "perm.deny": { de: "Ablehnen", en: "Deny" },
  "perm.allow": { de: "Erlauben", en: "Allow" },

  // provider picker (header)
  "pp.chipTitle": { de: "LLM-Backend wechseln", en: "Switch LLM backend" },
  "pp.provider": { de: "Provider", en: "Provider" },
  "pp.model": { de: "Modell", en: "Model" },
  "pp.switch": { de: "Wechseln", en: "Switch" },
  "pp.chooseLocal": { de: "Modell wählen …", en: "Choose a model …" },
  "pp.localNote": {
    de: "Läuft komplett auf dieser Maschine — kein Key, kein externer Server. Der nächste Schritt zeigt die Modelle.",
    en: "Runs entirely on this machine — no key, no external server. The next step shows the models.",
  },
  "pp.custom": { de: "Eigenes Modell …", en: "Custom model …" },
  "pp.customPh": { de: "Modellnamen eingeben", en: "Type a model name" },
  "pp.keepPh": { de: "leer = aktuelles Modell behalten", en: "empty = keep the current model" },
  "pp.noList": {
    de: "gerade keine Modell-Liste vom Backend; Modell-ID eintippen",
    en: "no model list from the backend right now; type the model id",
  },
  "pp.notOffered": {
    de: "nicht in der Modell-Liste dieses Providers — deine Einstellung bleibt",
    en: "not in this provider's model list — your setting is kept",
  },
  "pp.needsKey": {
    de: "kein Key gesetzt — trag ihn in die .env (siehe Hilfe)",
    en: "no key set — add it to your .env (see the help)",
  },
  "pp.setInSettings": { de: "Key in den Einstellungen setzen →", en: "set a key in Settings →" },
  "pp.localDown": {
    de: "backend nicht erreichbar — starte ollama / LM Studio (oder tipp eine Modell-ID)",
    en: "backend not reachable — start ollama / LM Studio (or type a model id)",
  },
  "pp.keySave": { de: "in .env speichern", en: "save to .env" },
  "pp.keySaving": { de: "speichere …", en: "saving …" },
  "pp.keySaved": {
    de: "gespeichert ✓ — ein neuer chat nutzt den key",
    en: "saved ✓ — a new chat will use it",
  },
  "pp.keyErr": { de: "speichern fehlgeschlagen", en: "could not save the key" },

  // reasoning control (card 88) — the seg in the picker and in Settings.
  // Effort tokens (low/medium/…) are wire vocabulary and render untranslated.
  "rc.label": { de: "denken", en: "thinking" },
  "rc.aria": { de: "Reasoning des Modells steuern", en: "Control the model's reasoning" },
  "rc.on": { de: "an", en: "on" },
  "rc.off": { de: "aus", en: "off" },
  "rc.onTitle": { de: "Reasoning explizit anfordern", en: "request reasoning explicitly" },
  "rc.offTitle": {
    de: "Reasoning abschalten — echt, am Draht",
    en: "turn reasoning off — for real, on the wire",
  },
  "rc.clearTitle": {
    de: "nochmal klicken: zurück zum Modell-Standard",
    en: "click again: back to the model default",
  },
  "rc.effortTitle": { de: "Effort {level} anfordern", en: "request {level} effort" },
  "rc.offCap": {
    de: "aus gibt es bei diesem Modell nur bis {level}",
    en: "this model allows off only up to {level}",
  },
  "rc.noOff": { de: "dieses Modell hat keinen echten Aus-Schalter", en: "this model has no real off switch" },
  "rc.noneThinks": {
    de: "kein Schalter — dieses Modell zeigt sein Denken immer",
    en: "no switch here — this model always shows its thinking",
  },
  "rc.noneQuiet": {
    de: "kein Schalter — dieses Modell hat kein Denken zu zeigen",
    en: "no switch here — this model has no thinking to show",
  },
  "rc.settingsLabel": { de: "Reasoning (pro Modell)", en: "Reasoning (per model)" },
  "rc.settingsNote": {
    de: "Gilt pro Modell, gemerkt in diesem Browser. Angeboten wird nur, was das Modell laut Capability-Record kann.",
    en: "Per model, remembered in this browser. Only what the model's capability record supports is offered.",
  },

  // right panel
  "rp.agents": { de: "Agenten", en: "Agents" },
  "rp.context": { de: "System-Kontext", en: "System context" },
  "rp.plan": { de: "Plan", en: "Plan" },
  "rp.files": { de: "Dateien", en: "Files" },
  "rp.close": { de: "Panel schließen", en: "Close panel" },

  // workspace tab (phase 5)
  "ws.rootTitle": {
    de: "Arbeitsverzeichnis des Agenten (sandboxed, nur lesen)",
    en: "The agent's working directory (sandboxed, read-only)",
  },
  "ws.refresh": { de: "Baum neu laden", en: "Reload the tree" },
  "ws.pick": { de: "Ordner wählen …", en: "Choose folder …" },
  "ws.pickTitle": {
    de: "Öffnet den nativen Ordner-Dialog auf dem spectroscope-Rechner — der gewählte Ordner wird der Workspace DIESER Session (nur vor dem ersten Lauf)",
    en: "Opens the native folder dialog on the spectroscope machine — the picked folder becomes THIS session's workspace (before the first run only)",
  },
  "ws.pickLocked": {
    de: "Der Workspace ist fixiert, sobald der Agent gelaufen ist — neuer Chat für einen anderen Ordner",
    en: "The workspace is fixed once the agent has run — start a new chat for a different folder",
  },
  "ws.empty": { de: "Keine Dateien im Arbeitsverzeichnis.", en: "No files in the working directory." },
  "ws.truncated": { de: "… Liste gekappt (zu viele Einträge)", en: "… listing capped (too many entries)" },
  "ws.hint": {
    de: "Klick links eine Datei — HTML rendert sandboxed, Markdown formatiert, Bilder inline, Rest als Text.",
    en: "Click a file — HTML renders sandboxed, markdown formatted, images inline, everything else as text.",
  },
  "ws.loading": { de: "lädt …", en: "loading …" },
  "ws.binary": { de: "Binärdatei — keine Vorschau.", en: "Binary file — no preview." },
  "ws.tooBig": { de: "Zu groß für die Vorschau.", en: "Too large for the preview." },
  "ws.loadError": { de: "Datei nicht ladbar.", en: "Could not load the file." },
  "ws.unreachable": {
    de: "Server nicht erreichbar — kein Dateibaum.",
    en: "Server unreachable — no file tree.",
  },

  // plan tab
  "plan.empty": {
    de: "Noch kein Plan. Sobald der Agent update_plan aufruft, erscheint hier seine Schritt-für-Schritt-Liste.",
    en: "No plan yet. As soon as the agent calls update_plan, its step-by-step list appears here.",
  },
  "plan.pending": { de: "offen", en: "open" },
  "plan.in_progress": { de: "läuft …", en: "running …" },
  "plan.completed": { de: "fertig", en: "done" },

  // tool cards (chat)
  "gate.pending": { de: "Gate: wartet …", en: "gate: waiting …" },
  "gate.allowed": { de: "Gate: erlaubt", en: "gate: allowed" },
  "gate.denied": { de: "Gate: abgelehnt", en: "gate: denied" },
  "tool.running": { de: "läuft", en: "running" },
  "tool.noResult": { de: "kein Ergebnis", en: "no result" },
  "tool.denied": { de: "abgelehnt", en: "denied" },
  "tool.deniedByUser": { de: "vom Nutzer abgelehnt", en: "denied by user" },
  "common.copy": { de: "Kopieren", en: "Copy" },
  "common.copied": { de: "Kopiert", en: "Copied" },
  "common.copyReadable": { de: "Lesbares kopieren", en: "Copy readable" },

  // lab toolbar
  "lab.blocks": { de: "Blöcke", en: "Blocks" },
  "lab.single": { de: "Einzeln", en: "Single" },
  "lab.tempo": { de: "Tempo", en: "Speed" },
  "lab.tempoTitle": { de: "Abspiel-Tempo im Flow-Modus", en: "Playback speed in flow mode" },
  "lab.reset": { de: "Reset", en: "Reset" },
  "lab.all": { de: "Alle", en: "All" },
  "lab.allTitle": {
    de: "Alle JSONL-Zeilen anzeigen (ohne Fenster-Begrenzung)",
    en: "Show every JSONL line (no windowing)",
  },
  "lab.viewingArchive": { de: "Archiv-Ansicht · nur lesen", en: "Viewing archive · read-only" },
  "lab.returnLive": { de: "Zurück zu Live", en: "Return to live" },

  // lab toolbar (part 2: titles, waiting, captions)
  "lab.grainCoarseTitle": {
    de: "Ein Klick = ein sinnvoller Block (Thinking-Lauf, Antwort, einzelnes Event)",
    en: "One click = one meaningful block (a thinking run, an answer, a single event)",
  },
  "lab.grainFineTitle": { de: "Ein Klick = eine JSONL-Zeile", en: "One click = one JSONL line" },
  "lab.grainAria": { de: "Schrittweite", en: "Step grain" },
  "lab.stepBackTitle": {
    de: "Letzten Step zurücknehmen (Chat und Karte gehen mit zurück)",
    en: "Undo the last step (chat and map go back too)",
  },
  "lab.stepTitle": { de: "Nächste(s) Event(s) anwenden", en: "Apply the next event(s)" },
  "lab.waiting": { de: "{n} wartend", en: "{n} waiting" },
  "lab.waitingServer": { de: "wartet auf den Server …", en: "waiting for server …" },
  // Reading aid under the map. It names red only, because that is the one fill
  // the packet keeps across designs (--error); the normal fill is --accent and
  // changes with the theme. A local model is drawn inside the machine frame,
  // so the left/right split is machine vs. network, not agent vs. model.
  "lab.hint": {
    de: "Ein Schritt wendet die nächsten Events an; danach steht das Paket auf der Station, die der Lauf erreicht hat. Links dein Rechner mit dem Agenten, dem Betriebssystem und einem lokalen Modell, rechts ein entferntes Modell, das Netz und der MCP-Server. Schlägt eine Strecke fehl, wird das Paket rot.",
    en: "Each step applies the next events and leaves the packet on the station the run has reached. Your machine is on the left with the agent, the operating system and a local model; a remote model, the network and the MCP server sit on the right. A failed leg turns the packet red.",
  },

  // the system map / flow map (shared wording)
  "map.gate.none": { de: "bereit", en: "ready" },
  "map.gate.pending": { de: "wartet auf dich …", en: "waiting for you …" },
  "map.gate.allowed": { de: "erlaubt", en: "allowed" },
  "map.gate.denied": { de: "abgelehnt", en: "denied" },
  "map.life.submitted": { de: "übergeben", en: "handed over" },
  "map.life.working": { de: "arbeitet …", en: "working …" },
  "map.life.completed": { de: "fertig", en: "done" },
  "map.life.failed": { de: "fehlgeschlagen", en: "failed" },
  "map.act.thinking": { de: "denkt nach …", en: "thinking …" },
  "map.act.thinkingShort": { de: "denkt …", en: "thinking …" },
  "map.act.writes": { de: "schreibt {f}", en: "writes {f}" },
  "map.act.reads": { de: "liest {f}", en: "reads {f}" },
  "map.act.file": { de: "datei", en: "file" },
  "map.act.plans": { de: "plant den nächsten Schritt", en: "plans the next step" },
  "map.act.plansShort": { de: "plant …", en: "planning …" },
  "map.zone.system": { de: "AGENTENSYSTEM", en: "AGENT SYSTEM" },
  "map.zone.mac": { de: "AGENTENSYSTEM · DEIN MAC", en: "AGENT SYSTEM · YOUR MAC" },
  "map.zone.fleetMac": { de: "FLOTTE · DEIN MAC", en: "FLEET · YOUR MAC" },
  "fleetlab.aria": { de: "Flotten-Maschinenraum", en: "Fleet machine room" },
  "lab.viewAria": { de: "Karten-Ansicht", en: "Card view" },
  "map.ctx.genImage": { de: "generiertes Bild", en: "generated image" },
  "map.ctx.attached": { de: "mitgegebene Bilder", en: "pictures handed over" },
  "set.secFleet": { de: "Flotte", en: "Fleet" },
  "set.fleetHint": {
    de: "Beides war bisher nur als Umgebungsvariable zu setzen. Beides wird beim Start gelesen — gespeichert wird auf die Platte, in Kraft ist es nach einem Neustart.",
    en: "Both of these were env-var-only until now. Both are read at startup: saving puts the value on disk, and it takes effect on the next start.",
  },
  "set.hubPort": { de: "Hub-Port (SPECTRO_HUB_PORT)", en: "hub port (SPECTRO_HUB_PORT)" },
  "set.allowSpawn": { de: "Nodes aus der UI starten", en: "start nodes from the UI" },
  "set.allowSpawnWhat": {
    de: "SPECTRO_ALLOW_SPAWN — braucht zusätzlich einen laufenden Hub",
    en: "SPECTRO_ALLOW_SPAWN — also needs a running hub",
  },
  "set.allowSpawnWarn": {
    de: "Das erlaubt dieser Oberfläche, auf deiner Maschine Prozesse zu starten. Jeder so gestartete Node läuft erzwungen mit --permissions readonly: er darf lesen, aber nie schreiben oder Kommandos ausführen. Der Server nimmt den Befehl trotzdem nur von dieser Maschine an.",
    en: "This lets this interface start processes on your machine. Every node started this way runs with --permissions readonly, forced: it can read, but never write or run commands. The server still accepts the request from this machine only.",
  },
  "set.envWins": {
    de: "Grau bedeutet: eine echte Umgebungsvariable hält diesen Wert. Die gewinnt, solange dieser Prozess läuft.",
    en: "Greyed out means a real environment variable holds that value. It wins for as long as this process runs.",
  },
  "set.restartNeeded": {
    de: "gespeichert — in Kraft nach einem Neustart des Servers",
    en: "saved — in force after the server restarts",
  },
  "set.saveFailed": { de: "konnte nicht gespeichert werden", en: "could not be saved" },
  "set.secObservability": { de: "Observability", en: "Observability" },
  "set.otlpHint": {
    de: "Jeder Run streamt seine Spans zusätzlich an einen OTLP-Endpoint (Langfuse, Jaeger, …) — die JSONL-Datei bleibt der Anker; ein toter Endpoint bremst nie einen Run.",
    en: "Every run also streams its spans to an OTLP endpoint (Langfuse, Jaeger, …) — the JSONL file stays the anchor; a dead endpoint never slows a run.",
  },
  "set.otlpEndpoint": { de: "OTLP-Endpoint", en: "OTLP endpoint" },
  "set.otlpAuth": { de: "Basic-Auth (pk:sk, optional)", en: "Basic auth (pk:sk, optional)" },
  // Docker detection (card 137). spectroscope reads whether Docker is usable
  // and offers the next step. It never starts anything; the operator runs the
  // command. Each state gets its own sentence, because telling someone with a
  // stopped daemon to install Docker is the failure this block exists to avoid.
  "set.dockerUnknown": { de: "Docker-Status wird gelesen …", en: "Reading Docker status …" },
  "set.dockerAbsent": {
    de: "Docker ist auf diesem Rechner nicht installiert. Langfuse läuft als Container-Stack, also brauchst du Docker zuerst.",
    en: "Docker is not installed on this machine. Langfuse runs as a container stack, so Docker comes first.",
  },
  "set.dockerInstall": { de: "Docker Desktop laden", en: "Get Docker Desktop" },
  "set.dockerDown": {
    de: "Docker ist installiert, der Daemon antwortet nicht. Starte Docker Desktop und öffne die Settings erneut.",
    en: "Docker is installed and the daemon is not answering. Start Docker Desktop, then reopen Settings.",
  },
  "set.dockerNoCompose": {
    de: "Der Docker-Daemon läuft, das compose-Plugin fehlt. Ohne compose lässt sich der Stack nicht starten.",
    en: "The Docker daemon is running and the compose plugin is missing. Without compose the stack cannot start.",
  },
  "set.dockerRemote": {
    de: "DOCKER_HOST zeigt auf einen Daemon auf einem anderen Rechner. Der Stack würde dort laufen, nicht hier auf localhost.",
    en: "DOCKER_HOST points at a daemon on another machine. The stack would run there, not on localhost here.",
  },
  "set.dockerReady": {
    de: "Docker läuft. Dieser Befehl startet einen lokalen Langfuse-Stack:",
    en: "Docker is running. This command starts a local Langfuse stack:",
  },
  "set.langfuseCommand": { de: "Befehl kopieren", en: "Copy command" },
  "set.langfuseCost": {
    de: "Das startet sechs Container und lädt einige Gigabyte an Images. spectroscope führt den Befehl nicht aus, du führst ihn aus. Das Skript legt Endpoint und Key-Paar selbst in ~/.spectro/.env ab; danach diesen Server einmal neu starten.",
    en: "That starts six containers and downloads a few gigabytes of images. spectroscope does not run the command, you do. The script writes the endpoint and the key pair into ~/.spectro/.env itself; restart this server once afterwards.",
  },
  "doc.otlp": { de: "OTLP-Export", en: "OTLP export" },
  "doc.otlpOff": { de: "aus — kein Endpoint gesetzt (Settings)", en: "off — no endpoint set (Settings)" },
  "doc.otlpOk": { de: "erreichbar + authentifiziert", en: "reachable + authenticated" },
  "lab.viewCompact": { de: "kompakt", en: "compact" },
  "lab.viewExpanded": { de: "aufgeklappt", en: "expanded" },
  "lab.face": { de: "Ansicht", en: "view" },
  "lab.faceAria": { de: "Ansicht für Tool-Panels", en: "Face for tool panels" },
  "lab.faceHint": {
    de: "Legt fest, in welcher Ansicht die Tool-Panels der Map ihren Aufruf zeigen. Umschalten holt auch offene Panels auf diese Ansicht; ein einzelnes Panel kannst du danach weiter umschalten.",
    en: "Sets which face the map's tool panels show their call in. Switching it brings open panels along too; a single panel can still be switched afterwards.",
  },
  "lab.faceTitle.insight": {
    de: "Den Tool-Aufruf als JSON-Baum zeigen — genau die Felder der JSONL-Zeile.",
    en: "Show the tool call as a JSON tree — exactly the fields of the JSONL line.",
  },
  "lab.faceTitle.structured": {
    de: "Den Tool-Aufruf als das zeigen, was er ist — ein Kommando als Terminal, ein Edit als Vorher/Nachher.",
    en: "Show the tool call as the thing it is — a command as a terminal, an edit as its before/after.",
  },
  "lab.viewCompactTitle": {
    de: "Kompakte Karten — Details hinter den Aufklappern",
    en: "Compact cards — details behind the disclosures",
  },
  "lab.viewExpandedTitle": {
    de: "Alles offen: Kontext neben dem Agenten, Prompt neben dem User — das ganze Instrument auf einen Blick",
    en: "Everything open: context beside the agent, prompt beside the user — the whole instrument at a glance",
  },
  "fleetlab.live": { de: "live", en: "live" },
  "fleetlab.behind": { de: "{n} events voraus", en: "{n} events ahead" },
  "map.zone.os": { de: "BETRIEBSSYSTEM", en: "OPERATING SYSTEM" },
  "map.zone.outside": { de: "AUSSERHALB", en: "OUTSIDE" },
  "map.zone.boundary": { de: "NETZGRENZE", en: "NETWORK BOUNDARY" },
  "map.you": { de: "Du", en: "You" },
  "map.node.gate": { de: "Permission-Gate", en: "Permission gate" },
  "map.node.mcpClient": { de: "MCP-CLIENT", en: "MCP CLIENT" },
  "map.node.netStack1": { de: "Netzwerk-", en: "network" },
  "map.node.netStack2": { de: "stack", en: "stack" },
  "map.node.network": { de: "Netzwerk", en: "Network" },
  "map.node.netz": { de: "Netz", en: "Net" },
  "map.node.mcpServer": { de: "MCP-SERVER", en: "MCP SERVER" },
  "map.extServer": { de: "externer Server", en: "external server" },
  "map.local": { de: "lokal", en: "local" },
  "map.remote": { de: "remote", en: "remote" },
  "map.more": { de: "+{n} weitere", en: "+{n} more" },
  "map.aria": {
    de: "System-Map: das Agentensystem und die externen Dienste",
    en: "System map: the agent system and the external services",
  },
  "map.legend.live": {
    de: "Live-Paket (wo es gerade passiert)",
    en: "live packet (where it happens right now)",
  },
  "map.legend.activeRail": { de: "aktive Schiene (wo es passiert)", en: "active rail (where it happens)" },
  "map.legend.inside": { de: "im Agentensystem", en: "inside the agent system" },
  "map.legend.out": { de: "nach außen (Netz)", en: "outbound (network)" },
  "map.legend.read": { de: "lesen", en: "read" },
  "map.legend.write": { de: "schreiben", en: "write" },
  "map.legend.writeLive": { de: "schreiben · Live-Paket", en: "write · live packet" },
  "map.user.typing": { de: "tippt …", en: "typing …" },
  "map.loop.note": { de: "plant · ruft Tools · liest Ergebnis", en: "plans · calls tools · reads results" },
  "map.disc.context": { de: "System-Kontext & aktuelle Aktion", en: "System context & current action" },
  "map.ctx.systemPrompt": { de: "System-Prompt", en: "System prompt" },
  "map.ctx.toLlm": { de: "Kontext an das LLM", en: "Context sent to the LLM" },
  "map.ctx.toolCall": { de: "Tool-Call", en: "Tool call" },
  "map.ctx.noTool": {
    de: "Kein Tool aktiv — der Agent plant.",
    en: "No tool active, the agent is planning.",
  },
  "map.shell.cmd": { de: "Befehl", en: "Command" },
  "map.mcp.call": { de: "MCP-Aufruf", en: "MCP call" },
  "map.llm.reasoning": { de: "Reasoning & Antwort", en: "Reasoning & answer" },
  "map.llm.answer": { de: "Antwort", en: "Answer" },
  "map.sub.disc": { de: "Task & Verlauf", en: "Task & history" },
  "map.sub.order": { de: "Auftrag", en: "Task" },
  "map.sub.lastStatus": { de: "Letzter Status:", en: "Last status:" },

  // trace tab
  "trace.filterPh": { de: "Frames filtern …", en: "Filter frames …" },
  "trace.filterAria": {
    de: "Trace nach Typ, Agent oder Payload filtern",
    en: "Filter trace entries by type, agent, or payload",
  },
  "trace.dirAria": { de: "LLM-Richtung", en: "LLM direction" },
  "trace.dirAll": { de: "alle Frames", en: "all frames" },
  "trace.dirTo": { de: "an die LLM (Anfrage)", en: "to the LLM (request)" },
  "trace.dirFrom": { de: "von der LLM (Antwort)", en: "from the LLM (response)" },
  "trace.dirInternal": {
    de: "harness-intern (nicht an die LLM)",
    en: "harness-internal (never reaches the LLM)",
  },
  "trace.llmColTitle": {
    de: "Richtung relativ zur LLM: ↑ Anfrage · ↓ Antwort · · intern",
    en: "Direction relative to the LLM: ↑ request · ↓ response · · internal",
  },
  "trace.sysRowTitle": {
    de: "an die LLM · als system-Rolle bei JEDEM Request (UI-only, kein Wire-Event)",
    en: "to the LLM · as the system role on EVERY request (UI-only, not a wire event)",
  },
  "trace.sysSummary": {
    de: "System-Prompt {n} Z. · {t} Tools · {s} Skills — als system-Rolle bei jedem Request",
    en: "System prompt {n} chars · {t} tools · {s} skills — sent as the system role on every request",
  },
  "trace.sysNote": {
    de: "UI-only, kein Wire-Event — der System-Prompt wird als 'system'-Rolle bei JEDEM Request mit hochgeladen.",
    en: "UI-only, not a wire event — the system prompt is uploaded as the 'system' role with EVERY request.",
  },
  "trace.empty": {
    de: "Die Leitung ist still. Frames erscheinen hier, sobald der Socket sie trägt — in beide Richtungen.",
    en: "The wire is quiet. Frames appear here as soon as the socket carries them — in both directions.",
  },
  "trace.noMatch": { de: "Keine Frames passen zum Filter.", en: "No frames match the current filter." },
  "trace.count": { de: "{v} von {t}", en: "{v} of {t}" },
  "trace.new": { de: "{n} neue ↓", en: "{n} new ↓" },
  "trace.toStart": { de: "Zum Anfang springen", en: "Jump to the start" },
  "trace.toEnd": { de: "Zum Ende springen", en: "Jump to the end" },
  "trace.protoTitle": {
    de: "Auf welchem Draht die Payload fährt: SSE (Claude/OpenAI-Stream), NDJSON (Ollama), JSON-RPC (MCP/stdio), HTTP (web_fetch/web_search/browse_page, Bilder), local (Datei-Tools), — (harness-intern)",
    en: "The wire the payload rides: SSE (Claude/OpenAI stream), NDJSON (Ollama), JSON-RPC (MCP/stdio), HTTP (web_fetch/web_search/browse_page, images), local (file tools), — (harness-internal)",
  },
  "trace.hostTitle": {
    de: "Die Gegenstelle im Netz: api.anthropic.com, localhost:11434 (Ollama), der MCP-Server, der web_fetch/browse_page-Host — live aus dem provider_info-Frame; Replays kennen nur den Provider",
    en: "The network counterpart: api.anthropic.com, localhost:11434 (Ollama), the MCP server, the web_fetch/browse_page host — live from the provider_info frame; replays only know the provider",
  },
  "trace.note.skill": { de: "Skill", en: "skill" },
  "trace.note.skillTitle": {
    de: "Diesen Turn trieb ein Skill. Der Name steht wörtlich so in der importierten Datei, Plugin-Präfix inklusive; spectroscope schlägt nichts nach. Steht nichts da, sagt die Datei nichts dazu.",
    en: "A skill was driving this turn. The name is verbatim from the imported file, plugin prefix and all; spectroscope looks nothing up. No chip means the file says nothing about it.",
  },
  "trace.note.mcp": { de: "MCP", en: "mcp" },
  "trace.note.mcpTitle": {
    de: "Was dieser Turn tut, geht auf die Ausgabe eines MCP-Tools zurück — Server und Tool, wie die Datei sie schreibt. Der Marker bleibt über mehrere Turns stehen: er gehört dem TURN, nicht dem einzelnen Aufruf.",
    en: "What this turn is doing goes back to an MCP tool's output — the server and the tool, spelled as the file spells them. The marker stays for several turns: it belongs to the TURN, not to one call.",
  },
  "trace.note.effort": { de: "Aufwand", en: "effort" },
  "trace.note.effortTitle": {
    de: "Wie stark dieser Turn denken sollte, wie die importierte Datei es aufgezeichnet hat. Die Stufe steht wörtlich da; spectroscope deutet sie nicht. Zeilen ohne dieses Feld tragen den Chip nicht.",
    en: "How hard this turn was told to think, as the imported file recorded it. The level is verbatim; spectroscope does not interpret it. A line without the field wears no chip.",
  },
  "trace.note.origin": { de: "geschrieben von", en: "written by" },
  "trace.note.originTitle": {
    de: "Diesen Nutzer-Turn hat keine Person geschrieben, sondern das, was hier steht (eine Task-Meldung, ein Koordinator). Die Datei nennt es; steht nichts da, sagt die Datei nichts dazu, und das heißt NICHT automatisch Mensch.",
    en: "No person wrote this user turn: the file names what did (a task notification, a coordinator). No chip means the file says nothing about it, which does NOT mean a person wrote it.",
  },
  "trace.note.truncated": { de: "abgeschnitten", en: "cut off" },
  "trace.note.truncatedTitle": {
    de: "Diese Antwort hörte an einer Grenze auf, nicht von selbst: max_tokens ist die Token-Decke, stop_sequence eine gesetzte Abbruch-Folge. Der Text bricht ab, ohne es zu sagen; die Datei sagt es hier.",
    en: "This answer stopped at a limit rather than on its own: max_tokens is the token ceiling, stop_sequence a configured cut. The text just stops without saying so; the file says it here.",
  },
  "trace.note.fallback": { de: "Modell getauscht", en: "model swapped" },
  "trace.note.fallbackTitle": {
    de: "Mitten im Lauf wurde das Modell ausgetauscht. Der Wechsel selbst steht als provider_info im Trace; die Datei nennt hier auch das Modell, das verlassen wurde.",
    en: "The model was swapped mid-run. The change itself stands in the trace as provider_info; the file also names the model that was left behind, which is what this says.",
  },
  "tf.modeAria": { de: "Text-Ansicht", en: "Text view" },
  "tf.modeTextTitle": {
    de: "ALLER Text in Leserichtung — das Protokoll als sichtbare Marker: <think>/</think> um jede Denkphase, [tool_call …]-Indikatoren mit vollem Input und Output, Gate, Lauf-Grenzen",
    en: "ALL text in reading order — the protocol as visible markers: <think>/</think> around each reasoning run, [tool_call …] indicators with full input and output, the gate, run boundaries",
  },
  "tf.modeJsonlTitle": {
    de: "Die Session als JSONL, eine Zeile pro Wire-Event, exakt wie die Datei auf der Platte (Socket-Frames und importierte Frames stehen nie in der Datei)",
    en: "The session as JSONL, one line per wire event, exactly like the file on disk (socket frames and imported frames never enter the file)",
  },
  "tf.textNote": {
    de: "Text-Feed: <think>-Marker, Tool-Indikatoren, voller Output",
    en: "Text feed: <think> markers, tool indicators, full output",
  },
  "tf.jsonlNote": {
    de: "{n} JSONL-Zeilen — exakt das Dateiformat",
    en: "{n} JSONL lines — exactly the file format",
  },
  "tf.empty": {
    de: "Noch keine Events — schicke eine Nachricht oder öffne eine Session.",
    en: "No events yet — send a message or open a session.",
  },
  "tf.explain": { de: "erklären", en: "explain" },
  "tf.explainTitle": {
    de: "Diesen Run von einem Modell deuten lassen — die kausale Geschichte über Reasoning, Tools und Gates. Das Gates-Panel im Trace bleibt die deterministische Sicht.",
    en: "Have a model read this run — the causal story across reasoning, tools and gates. The trace tab's gates panel stays the deterministic view.",
  },
  "tf.explainHonesty": {
    de: "modellgenerierte Deutung des aufgezeichneten Runs — keine Modell-Interna",
    en: "model-generated reading of the recorded run — not model internals",
  },
  "tf.explainNeedsProvider": {
    de: "braucht einen bereiten Provider — Key in den Settings setzen",
    en: "needs a ready provider — set a key in Settings",
  },
  "tf.explainStop": { de: "stopp", en: "stop" },
  "tf.explainClose": { de: "Deutung schließen", en: "Close the reading" },
  "tf.explainWorking": { de: "das Modell liest den Run …", en: "the model is reading the run …" },
  "tf.explainStopped": {
    de: "gestoppt — Teilstück bleibt stehen",
    en: "stopped — the partial reading stays",
  },
  "tf.explainFailed": { de: "Deutung fehlgeschlagen: {msg}", en: "The reading failed: {msg}" },
  "ws.perSession": { de: "Session-Workspace", en: "session workspace" },
  "ws.pinned": { de: "fester Workspace", en: "pinned workspace" },
  // The tree drawn before any run: the folder the first run WILL work in. It
  // is not a session workspace, and there is no session yet to call it one.
  "ws.firstRunFolder": { de: "Ordner des ersten Laufs", en: "the first run's folder" },
  // The type chips. The nine that predate card 141 kept the exact lowercase
  // word they rendered before, in both languages, because that word is the
  // wire's own vocabulary and translating it would break the link between the
  // chip and the type column beside it (trace.lens and trace.timeline are
  // spelled the same way for the same reason). "client" is the tenth: what a
  // transcript recorded around the conversation, which is the todo list, the
  // prompt queue and the file that was edited.
  "trace.cat.run": { de: "run", en: "run" },
  "trace.cat.turn": { de: "turn", en: "turn" },
  "trace.cat.text": { de: "text", en: "text" },
  "trace.cat.thinking": { de: "thinking", en: "thinking" },
  "trace.cat.tool": { de: "tool", en: "tool" },
  // The two chips that ask what the tool was. Same word in both languages for
  // the same reason as their neighbours: it IS the wire vocabulary. "workflow"
  // is the tool's own name, and "mcp" is the prefix every tool served over MCP
  // wears, which is also what a reader recognises on the row.
  "trace.cat.workflow": { de: "workflow", en: "workflow" },
  "trace.cat.mcp": { de: "mcp", en: "mcp" },
  "trace.cat.permission": { de: "permission", en: "permission" },
  "trace.cat.usage": { de: "usage", en: "usage" },
  "trace.cat.image": { de: "image", en: "image" },
  // "llm" is the eleventh: the recorded exchange itself — what actually left
  // for the model and what came back, as the llm-wire sidecar measured it.
  "trace.cat.llm": { de: "llm", en: "llm" },
  "trace.cat.context": { de: "context", en: "context" },
  "trace.cat.client": { de: "client", en: "client" },
  "trace.cat.other": { de: "other", en: "other" },
  // Counting words for a todo list's statuses (card 141). Separate from the
  // plan badge's plan.* labels on purpose: "läuft …" is right on ONE running
  // step and is not a German sentence after a number, which the live pass
  // caught as "2 läuft …". These count, those label.
  "trace.todo.pending": { de: "offen", en: "open" },
  "trace.todo.in_progress": { de: "in Arbeit", en: "running" },
  "trace.todo.completed": { de: "fertig", en: "done" },
  "trace.typesAria": { de: "Event-Typen", en: "Event types" },
  "trace.all": { de: "alle", en: "all" },
  "trace.none": { de: "keine", en: "none" },
  "trace.selectAll": { de: "alle Typen anzeigen", en: "show all types" },
  "trace.selectNone": { de: "alle Typen ausblenden", en: "hide all types" },
  "trace.logAria": { de: "Wire-Trace", en: "Wire trace" },
  "trace.modeAria": { de: "Detail-Ansicht", en: "Detail view" },
  "trace.mode.insight": { de: "Insight", en: "Insight" },
  "trace.mode.compact": { de: "Compact", en: "Compact" },
  "trace.mode.wire": { de: "Draht", en: "Wire" },
  "trace.mode.source": { de: "Quelle", en: "Source" },
  // The llm-wire detail pane (wire/llmWire.ts): one honest sentence per
  // fidelity, said per SIDE — the request and the response of one exchange can
  // be recorded at different fidelities.
  "trace.llm.fid.bytes": {
    de: "bytes — aufgezeichnet, wie es gesendet wurde",
    en: "bytes — recorded as posted",
  },
  "trace.llm.fid.sdk-json": {
    de: "sdk-json — die eigene Serialisierung des SDK, in Tests als identisch gemessen",
    en: "sdk-json — the SDK's own serialization, measured equal in tests",
  },
  "trace.llm.fid.sdk-events": {
    de: "sdk-events — rekonstruiert aus den typisierten Events des SDK",
    en: "sdk-events — reconstructed from the SDK's typed events",
  },
  "trace.llm.fid.encoded": {
    de: "encoded — das eigene base64 der Aufzeichnung über die echten Eingabe-Bytes",
    en: "encoded — the recording's own base64 of the real input bytes",
  },
  "trace.llm.imported": {
    de: "Diese Session wurde importiert — ihr eigenes Source-Gesicht ist der Draht; einen llm-wire-Mitschnitt gibt es nicht.",
    en: "This session was imported — its own source face is the wire; no llm-wire record exists.",
  },
  "trace.llm.loading": {
    de: "der aufgezeichnete Austausch wird geladen …",
    en: "fetching the recorded exchange …",
  },
  "trace.llm.failed": {
    de: "Der aufgezeichnete Austausch hat nicht geantwortet — die Sidecar-Datei kann fehlen, oder der Server ist älter als diese Ansicht.",
    en: "The recorded exchange did not answer — the sidecar file may be missing, or the server predates this view.",
  },
  "trace.llm.blobTitle": {
    de: "Ein base64-Lauf, den die Ansicht nicht druckt; die Zahl ist an der aufgezeichneten Zeile gemessen.",
    en: "A run of base64 the pane does not print; the count is measured on the recorded line.",
  },
  "trace.llm.linesCap": {
    de: "{shown} von {total} Antwort-Zeilen gezeigt.",
    en: "showing {shown} of {total} response lines.",
  },
  "trace.llm.omittedCeiling": {
    de: "Der Body wurde an der Aufzeichnungs-Obergrenze verworfen — das Ledger trägt weiterhin seine gemessene Größe.",
    en: "body dropped at the recording ceiling — the ledger still carries its measured size.",
  },
  "trace.llm.noResponse": {
    de: "keine Antwort aufgezeichnet — der Austausch wurde nie geschlossen.",
    en: "no response recorded — the exchange never closed.",
  },
  // The request in its PARTS (card 184). Labels are the wire's own words where
  // the wire has one: `system`, `messages`, `tools` are fields, not names we chose.
  "trace.llm.parts.system": { de: "system-Prompt", en: "system prompt" },
  "trace.llm.parts.messages": { de: "messages", en: "messages" },
  "trace.llm.parts.tools": { de: "tools", en: "tools" },
  "trace.llm.parts.blocks": { de: "{n} Blöcke", en: "{n} blocks" },
  // One block is one block. The count is right beside the word in a pane whose
  // whole promise is that it says what is there, and "1 blocks" reads as a
  // string somebody forgot to finish.
  "trace.llm.parts.block1": { de: "1 Block", en: "1 block" },
  "trace.llm.parts.chars": { de: "{chars} Zeichen", en: "{chars} chars" },
  "trace.llm.parts.more": { de: "{shown} von {total} gezeigt.", en: "showing {shown} of {total}." },
  // The audio face of an stt exchange (card 184/187): the recording as a
  // player instead of a wall of base64.
  "trace.llm.audio.play": { de: "Abspielen", en: "Play" },
  "trace.llm.audio.pause": { de: "Anhalten", en: "Pause" },
  "trace.llm.audio.scrub": { de: "In der Aufnahme spulen", en: "Scrub through the recording" },
  "trace.llm.audio.estimated": {
    de: "Wort-Timing aus der Wortl\u00e4nge gesch\u00e4tzt \u2014 die Aufzeichnung tr\u00e4gt keine Zeitstempel.",
    en: "Word timing estimated from word length \u2014 the record carries no timestamps.",
  },
  "trace.llm.audio.encodedAt": {
    de: "Zeichen {at} von {total} des base64-Bodys",
    en: "character {at} of {total} of the base64 body",
  },
  "trace.llm.audio.unreadable": {
    de: "Der Body ist kein lesbares PCM16-WAV \u2014 gezeigt wird sein Ma\u00df. Der Wire darunter ist unver\u00e4ndert.",
    en: "The body is not readable PCM16 WAV \u2014 shown as its measure. The wire below is unchanged.",
  },
  "trace.llm.parts.unknownShape": {
    de: "Diese Ansicht kennt die Form dieses Bodys nicht, also zeigt sie ihn als Baum statt in Teilen. Der Draht darunter ist unverändert.",
    en: "This pane does not know this body's shape, so it shows the tree instead of the parts. The wire below is unchanged.",
  },
  "trace.llm.res.lines": { de: "{n} Zeilen", en: "{n} lines" },
  "trace.llm.res.aborted": { de: "abgebrochen", en: "aborted" },
  "trace.llm.res.noReassembly": {
    de: "Die Antwort wird hier NICHT zusammengesetzt: der zusammengesetzte Text ist der Chat, und ein zweiter Zusammenbau im Browser wäre eine zweite Wahrheit. Was ankam, steht Zeile für Zeile auf dem wire-Gesicht.",
    en: "The answer is NOT reassembled here: the reassembled text is the chat, and a second reassembly in the browser would be a second truth. What arrived is on the wire face, line by line.",
  },
  // Open everything at once, and back (owner 2026-08-07). Two buttons and not a
  // toggle: "back to default" has to mean the pane as it opened, folds a reader
  // touched by hand included, and a toggle that left those open would not be a
  // way back at all.
  // Card 187 step 1: why the microphone did not work. Both paths used to be a
  // silent catch, so "you denied permission" and "the request failed" both read
  // as "this machine has no microphone".
  "voice.pick.title": { de: "Mikrofon wählen", en: "Choose a microphone" },
  "voice.pick.system": { de: "Systemvorgabe", en: "System default" },
  // Not an error: the browser HAS devices and withholds their names until the
  // microphone has been granted once. Saying so beats five blank rows.
  "voice.pick.unnamed": {
    de: "Die Namen der Geräte zeigt der Browser erst, wenn das Mikrofon einmal erlaubt wurde. Einmal aufnehmen — danach steht die Liste hier.",
    en: "The browser only names the devices once the microphone has been allowed. Record once, and the list appears here.",
  },
  "voice.pick.none": { de: "Kein Eingabegerät gefunden.", en: "No input device found." },
  // Card 187 step 7 — the first-run voice sheet. The route decides which set a
  // reader sees; the local lines never appear while the hosted route is taken.
  "voice.notice.title": { de: "Sprechen statt tippen", en: "Speak instead of typing" },
  "voice.notice.works": { de: "Das geht auf diesem Rechner.", en: "This works on this machine." },
  "voice.notice.blocked": { de: "Dafür fehlt noch etwas.", en: "Something is still missing for this." },
  "voice.notice.hosted.nothingToInstall": {
    de: "Nichts zu installieren — die Umwandlung passiert beim Anbieter.",
    en: "Nothing to install — the conversion happens at the provider.",
  },
  "voice.notice.hosted.keyThere": { de: "Der Schlüssel ist da ({v}).", en: "The key is there ({v})." },
  "voice.notice.hosted.keyMissing": {
    de: "Es fehlt ein Schlüssel in {v} — Einstellungen → Anbieter.",
    en: "A key is missing in {v} — Settings → Providers.",
  },
  "voice.notice.hosted.leaves": {
    de: "Die Aufnahme verlässt diesen Rechner und geht an {v}.",
    en: "The recording leaves this machine and goes to {v}.",
  },
  "voice.notice.local.binaryThere": { de: "whisper-cli ist installiert.", en: "whisper-cli is installed." },
  "voice.notice.local.binaryMissing": { de: "whisper-cli fehlt — {v}", en: "whisper-cli is missing — {v}" },
  "voice.notice.local.modelThere": { de: "Das Modell liegt schon hier.", en: "The model is already here." },
  "voice.notice.local.modelMissing": {
    de: "Das Modell fehlt — einmalig {v} zu laden.",
    en: "The model is missing — a one-time {v} download.",
  },
  "voice.notice.local.staysHere": {
    de: "Die Aufnahme verlässt diesen Rechner nicht.",
    en: "The recording never leaves this machine.",
  },
  "voice.notice.switchHint": {
    de: "Beide Wege stehen in den Einstellungen unter Spracheingabe.",
    en: "Both routes are in Settings, under Speech to text.",
  },
  "voice.notice.settings": { de: "Einstellungen", en: "Settings" },
  "voice.notice.gotIt": { de: "Verstanden", en: "Got it" },
  "voice.err.denied": {
    de: "Kein Zugriff aufs Mikrofon — der Browser hat ihn verweigert. In den Website-Einstellungen erlauben, dann noch einmal.",
    en: "No access to the microphone — the browser refused it. Allow it in the site settings, then try again.",
  },
  "voice.err.noDevice": { de: "Kein Mikrofon gefunden.", en: "No microphone found." },
  "voice.err.deviceBusy": {
    de: "Das Mikrofon ließ sich nicht öffnen — vermutlich hält es gerade ein anderes Programm.",
    en: "The microphone could not be opened — another program is probably holding it.",
  },
  "voice.err.sttMissing": {
    de: "Spracheingabe ist auf diesem Server nicht eingerichtet — Einstellungen → Spracheingabe.",
    en: "Speech to text is not set up on this server — Settings → Speech to text.",
  },
  "voice.err.requestFailed": {
    de: "Die Aufnahme kam nicht durch. Nichts wurde übertragen; einfach noch einmal.",
    en: "The recording did not get through. Nothing was sent; just try again.",
  },
  "voice.err.convertFailed": {
    de: "Die Aufnahme ließ sich nicht in Ton umwandeln, den das Modell liest. Gesendet wurde nichts.",
    en: "The recording could not be turned into audio the model reads. Nothing was sent.",
  },
  "voice.err.unknown": { de: "Die Aufnahme ist fehlgeschlagen.", en: "The recording failed." },
  "trace.dropped": {
    de: "Zeigt die letzten {shown} von {total} — {n} ältere sind aus dem Live-Fenster gefallen.",
    en: "Showing the last {shown} of {total} — {n} older rows fell out of the live window.",
  },
  "voice.live.label": { de: "Live mitschreiben", en: "Write along live" },
  "voice.live.on": {
    de: "Der Text erscheint beim Sprechen und wird am Ende ersetzt.",
    en: "The text appears as you speak and is replaced at the end.",
  },
  "voice.live.off": {
    de: "Der Text erscheint, wenn die Aufnahme fertig ist.",
    en: "The text appears once the recording is done.",
  },
  "voice.live.localRoute": {
    de: "Der lokale Weg schreibt erst mit, wenn die Aufnahme steht — er liest eine fertige Datei. Live geht über den Anbieter-Weg.",
    en: "The local route only writes once the recording is complete — it reads a finished file. Live runs over the provider route.",
  },
  "voice.live.upstream": {
    de: "Der Anbieter hat die Live-Sitzung abgelehnt oder abgebrochen. Gesprochen wurde, angekommen ist nichts Verwertbares.",
    en: "The provider refused or dropped the live session. You spoke, but nothing usable arrived.",
  },
  "voice.live.closed": {
    de: "Die Verbindung endete, bevor der Text fertig war. Der blasse Teil ist alles, was gehört wurde.",
    en: "The connection ended before the text was finished. The faded part is everything that was heard.",
  },
  "voice.live.noKey": {
    de: "Für den Anbieter-Weg fehlt der Schlüssel — Einstellungen → Anbieter.",
    en: "The provider route is missing its key — Settings → Providers.",
  },
  "set.secStt": { de: "Spracheingabe", en: "Speech to text" },
  "set.sttProvider": { de: "Weg der Spracheingabe", en: "Speech to text via" },
  "set.sttProvider.auto": {
    de: "automatisch — gehostet, wenn ein Key da ist",
    en: "automatic — hosted when a key is there",
  },
  "set.sttProvider.local": {
    de: "lokal — whisper.cpp, nichts verlässt den Rechner",
    en: "local — whisper.cpp, nothing leaves this machine",
  },
  "set.sttProvider.openai": {
    de: "gehostet — openai, ohne Installation",
    en: "hosted — openai, nothing to install",
  },
  "set.sttLanguage": { de: "Sprache der Diktate", en: "Dictation language" },
  "set.sttLanguage.auto": {
    de: "automatisch — das Modell erkennt sie",
    en: "automatic — the model detects it",
  },
  "set.sttLanguage.de": { de: "Deutsch", en: "German" },
  "set.sttLanguage.en": { de: "Englisch", en: "English" },
  "set.sttHostedReady": {
    de: "Gehostet ist einsatzbereit: {model}. Aufnahmen verlassen dabei diesen Rechner.",
    en: "The hosted route is ready: {model}. Recordings leave this machine on it.",
  },
  "set.sttHostedNoKey": {
    de: "Für den gehosteten Weg fehlt {key} — er lässt sich oben bei den Providern setzen.",
    en: "The hosted route needs {key} — it can be set with the providers above.",
  },
  "set.sttReadyHosted": {
    de: "Spracheingabe ist bereit — über den gehosteten Anbieter, ohne Installation.",
    en: "Speech to text is ready — through the hosted provider, with nothing installed.",
  },
  "set.sttHint": {
    de: "Zwei Wege: ein gehosteter Anbieter, der nichts als einen Key braucht, und whisper.cpp auf diesem Rechner, das keinen Key braucht und nichts nach außen gibt. Für den lokalen Weg lädt diese App das Modell; das Programm sucht sie nur und meldet ehrlich, was sie findet.",
    en: "Two routes: a hosted provider, which needs nothing but a key, and whisper.cpp on this machine, which needs no key and sends nothing out. For the local one this app fetches the model; the binary it only probes for and reports honestly.",
  },
  "set.sttPresent": { de: "da", en: "present" },
  "set.sttAbsent": { de: "fehlt", en: "absent" },
  "set.sttMissing": { de: "nicht gefunden", en: "not found" },
  "set.sttDownload": { de: "Modell laden ({size})", en: "download the model ({size})" },
  "set.sttDownloading": { de: "lädt … {done} von {total}", en: "downloading … {done} of {total}" },
  "set.sttBinaryHint": {
    de: "Zum Nachinstallieren, außerhalb dieser App:",
    en: "To install them, outside this app:",
  },
  "set.sttReady": { de: "Spracheingabe ist einsatzbereit.", en: "Speech input is ready." },
  "set.sttNotReady": {
    de: "Spracheingabe ist noch nicht einsatzbereit — der Mikrofon-Knopf bleibt aus.",
    en: "Speech input is not ready yet — the microphone button stays off.",
  },
  "trace.llm.expandAll": { de: "alles aufklappen", en: "expand all" },
  "trace.llm.expandDefault": { de: "Standard", en: "default" },
  "trace.llm.expandAria": {
    de: "Wie weit der Austausch aufgeklappt ist",
    en: "How far the exchange is unfolded",
  },
  "trace.llm.wire.noHeaders": {
    de: "keine Header aufgezeichnet — das SDK besitzt hier den Socket.",
    en: "no headers recorded — the SDK owns the socket here.",
  },

  // system-context tab
  "ctx.unavailable": {
    de: "System-Kontext nicht verfügbar (Server offline?).",
    en: "System context unavailable (server offline?).",
  },
  "ctx.leadMain": { de: "der Kontext des Haupt-Agenten.", en: "the main agent's context." },
  "ctx.leadSub": { de: "der Kontext von {id}.", en: "the context of {id}." },
  "ctx.leadPre": { de: "Das geht ans", en: "This goes to the" },
  "ctx.leadPost": { de: "bevor du etwas schickst —", en: "before you send anything —" },
  "ctx.rawTitle": { de: "Den ganzen Prompt im Vollbild zeigen", en: "Show the whole prompt fullscreen" },
  "ctx.model": { de: "Modell", en: "Model" },
  "ctx.on": { de: "an", en: "on" },
  "ctx.off": { de: "aus", en: "off" },
  "ctx.gateTitle": { de: "braucht deine Freigabe", en: "needs your approval" },
  "ctx.none": { de: "keine", en: "none" },
  "ctx.noneConfigured": { de: "keine konfiguriert", en: "none configured" },
  "ctx.mcpNote": {
    de: "MCP-Tools laden beim Verbinden (mcp__server__tool).",
    en: "MCP tools load on connect (mcp__server__tool).",
  },
  "ctx.roles": { de: "Subagenten-Rollen", en: "Subagent roles" },
  "ctx.rolesNote": {
    de: "Wähle oben einen Subagenten, um seinen Kontext zu sehen.",
    en: "Select a subagent above to see its context.",
  },
  "ctx.role": { de: "Rolle", en: "Role" },
  "ctx.type": { de: "Typ", en: "Type" },
  "ctx.kind": { de: "Art", en: "Kind" },
  "ctx.kindDev": { de: "Dev-Tool (läuft als worker)", en: "Dev tool (runs as a worker)" },
  "ctx.kindSpawn": { de: "Spawn", en: "Spawn" },
  "ctx.access": { de: "Zugriff", en: "Access" },
  "ctx.readOnly": { de: "nur lesen", en: "read-only" },
  "ctx.full": { de: "voll", en: "full" },
  "ctx.promptRole": { de: "System-Prompt (Rolle)", en: "System prompt (role)" },
  "ctx.taskSeen": { de: "Auftrag (was der Subagent sieht)", en: "Task (what the subagent sees)" },
  "ctx.noNesting": {
    de: "Bekommt NICHT die spawn/dev-Tools — Verschachtelung endet bei Tiefe 1.",
    en: "Does NOT get the spawn/dev tools — nesting ends at depth 1.",
  },
  "ctx.noProfile": { de: "Kein Rollen-Profil für {id} gefunden.", en: "No role profile found for {id}." },
  "ctx.noProfileRaw": { de: "(kein Rollen-Profil gefunden)", en: "(no role profile found)" },
  "ctx.rule.model": { de: "MODELL", en: "MODEL" },
  "ctx.rule.task": { de: "AUFTRAG", en: "TASK" },
  "ctx.rule.roles": { de: "SUBAGENTEN-ROLLEN", en: "SUBAGENT ROLES" },
  "ctx.chars": { de: "{n} Zeichen", en: "{n} chars" },
  "ctx.copy": { de: "kopieren", en: "copy" },
  "ctx.copied": { de: "kopiert ✓", en: "copied ✓" },

  // agents tab
  "agents.empty": {
    de: "Noch kein Lauf. Sobald du etwas schickst, erscheint hier der Haupt-Agent — und jeder Subagent, den er spawnt, bleibt für die Session sichtbar.",
    en: "No run yet. As soon as you send something, the main agent appears here — and every subagent it spawns stays visible for the session.",
  },
  "agents.main": { de: "Haupt", en: "Main" },
  "agents.launched": { de: "gestartet, ohne Rückmeldung", en: "launched, never reported back" },

  // work panel + chat v2 (branch chat-v2, prototype)
  "rp.work": { de: "Arbeit", en: "Work" },
  "work.title": { de: "Nebenher laufende Arbeit", en: "Work running alongside" },
  "work.empty": {
    de: "Keine nebenläufige Arbeit in dieser Session. Jeder Turn lief auf dem Haupt-Agenten — die Spalte links ist die ganze Geschichte.",
    en: "No concurrent work in this session. Every turn ran on the main agent, so the column on the left is the whole story.",
  },
  "work.emptyLive": {
    de: "Noch nichts. Subagenten, getriggerte Node-Läufe und gestartete Hintergrund-Tasks erscheinen hier, sobald es welche gibt.",
    en: "Nothing yet. Subagents, triggered node runs and launched background tasks appear here once there are any.",
  },
  "work.kind.spawn": { de: "Fan-out", en: "fan-out" },
  "work.kind.trigger": { de: "Getriggert", en: "triggered" },
  "work.kind.launched": { de: "Hintergrund", en: "background" },
  "work.done": { de: "{k} von {n} fertig", en: "{k} of {n} done" },
  "work.agentsN": { de: "{n} Agenten", en: "{n} agents" },
  "work.calls": { de: "{n} Tool-Calls", en: "{n} tool calls" },
  "work.gates": { de: "{n} am Gate", en: "{n} at the gate" },
  "work.denied": { de: "{n} verweigert", en: "{n} denied" },
  "work.gatePending": { de: "wartet am Gate", en: "waiting at the gate" },
  "work.noSpan": { de: "keine Zeitspanne aufgezeichnet", en: "no span recorded" },
  "work.opaque": {
    de: "meldet {n} Agenten · keiner davon in diesem Stream",
    en: "reports {n} agents · none of them in this stream",
  },
  "work.beside": {
    de: "{n} Agenten-Transkripte liegen neben dieser Datei",
    en: "{n} agent transcripts sit beside this file",
  },
  "work.besideClaim": { de: "die Aufgabe meldete {n}", en: "the task reported {n}" },
  "work.opaqueCalls": {
    de: "meldet {n} Tool-Calls · keiner davon als Frame",
    en: "reports {n} tool calls · none of them as a frame",
  },
  "work.missing": { de: "nicht in diesem Stream: {what}", en: "not in this stream: {what}" },
  "work.miss.agentRows": { de: "die Zeilen je Agent", en: "the per-agent rows" },
  "work.miss.tokens": { de: "Tokens", en: "tokens" },
  "work.miss.calls": { de: "Tool-Calls", en: "tool calls" },
  "work.miss.span": { de: "die Zeitspanne", en: "the span" },
  "work.miss.noWork": {
    de: "nichts von dieser Bahn — die Datei nennt sie und zeichnet sie nicht auf",
    en: "nothing of this lane — the file names it and records none of it",
  },
  "work.toTrace": { de: "im Trace öffnen", en: "open in the trace" },
  "work.noTrace": { de: "kein Frame dahinter", en: "no frame behind this" },
  "work.chip": { de: "{n} nebenher", en: "{n} alongside" },
  "work.chipOpen": { de: "im Arbeits-Panel zeigen", en: "show in the work panel" },
  "work.triggerNone": {
    de: "Getriggerte Node-Läufe (Karte 72) trägt der Draht bereits; keine aufgezeichnete Session hier hat einen. Sobald eine kommt, steht sie hier.",
    en: "Triggered node runs (card 72) are already on the wire; no recorded session here has one. The first one that arrives shows up here.",
  },
  "work.v1": { de: "v1 · wie aufgezeichnet", en: "v1 · as recorded" },
  "work.v1.hint": {
    de: "Subagenten-Turns stehen im Verlauf, in Stream-Reihenfolge",
    en: "subagent turns sit in the scroll, in stream order",
  },
  "work.v2": { de: "v2 · Arbeits-Panel", en: "v2 · work panel" },
  "work.v2.hint": {
    de: "links der Haupt-Agent, rechts was nebenher läuft",
    en: "the main agent on the left, what runs alongside on the right",
  },
  "work.mode": { de: "Lesart des Verlaufs", en: "How the transcript reads" },
  "work.proto": { de: "Prototyp", en: "prototype" },

  // design drawer
  "set.particleTag": { de: "Partikel", en: "Particles" },
  "set.scrollFx": { de: "Scroll-Effekte", en: "Scroll effects" },
  "set.particleFx": { de: "Partikel-Effekte", en: "Particle effects" },
  "set.noSignature": {
    de: "Dieses Skin hat keine Partikel-Signatur.",
    en: "This skin has no particle signature.",
  },
  "set.saved": { de: "✓ gespeichert", en: "✓ saved" },
  "set.title": { de: "Einstellungen", en: "Settings" },
  "set.secDesign": { de: "Design", en: "Design" },
  "set.secLanguage": { de: "Sprache", en: "Language" },
  "set.secSession": { de: "Session-Standards", en: "Session defaults" },
  "set.secWorkspace": { de: "Standard-Workspace", en: "Default workspace" },
  "set.secLogging": { de: "Operator-Logging", en: "Operator logging" },
  "set.sessionHint": {
    de: "Landet in ~/.spectro/settings.json und gilt ab der nächsten neuen Session. Zurücksetzen fällt auf die darunterliegende Ebene zurück (z. B. env).",
    en: "Lands in ~/.spectro/settings.json and applies from the next new session. Resetting falls back to the layer below (e.g. env).",
  },
  "set.provider": { de: "Provider", en: "Provider" },
  "set.model": { de: "Modell", en: "Model" },
  "set.thinking": { de: "Thinking", en: "Thinking" },
  "set.imageBackend": { de: "Bild-Backend", en: "Image backend" },
  "set.on": { de: "An", en: "On" },
  "set.off": { de: "Aus", en: "Off" },
  "set.wsNone": {
    de: "Kein Ordner gemerkt — neue Chats nutzen den Session-Ordner unter tmp.",
    en: "No folder remembered — new chats use the per-session temp folder.",
  },
  "set.logLevel": { de: "Log-Level (Boot)", en: "Log level (boot)" },
  "set.logHint": {
    de: "Diagnose läuft nach ~/.spectro/logs/spectroscope.log ([agentId]-Prefix).",
    en: "Diagnostics go to ~/.spectro/logs/spectroscope.log ([agentId] prefix).",
  },

  // settings page — provenance (Task 13: the header gear goes server-backed)
  "set.originDefault": { de: "Default", en: "default" },
  "set.originFrom": { de: "aus {layer}", en: "from {layer}" },
  "set.originShadows": { de: " · überschattet {layers}", en: " · shadows {layers}" },
  "set.layer.env": { de: "env", en: "env" },
  "set.layer.user": { de: "User-Settings", en: "user settings" },
  "set.layer.launchDir": { de: "Startordner", en: "launch dir" },
  "set.layer.project": { de: "Workspace-Projekt", en: "workspace project" },
  "set.layer.local": { de: "lokal", en: "local" },
  "set.layer.flags": { de: "Flags", en: "Flags" },
  "set.reset": { de: "Zurücksetzen", en: "Reset" },
  "set.pick": { de: "Ordner wählen …", en: "Choose folder …" },
  "set.wsApplies": {
    de: "Gilt ab der nächsten neuen Session; eine laufende Session behält ihren eigenen Workspace.",
    en: "Applies from the next new session; a running session keeps its own workspace.",
  },
  "set.wsResetToEnv": { de: "zurück zur env-Basis", en: "back to the env base" },
  "set.logApplies": {
    de: "Gilt sofort und beim nächsten Boot.",
    en: "Applies immediately and on the next boot.",
  },
  "set.loadError": {
    de: "Einstellungen nicht ladbar — Server nicht erreichbar?",
    en: "Could not load settings — server unreachable?",
  },
  "set.machine": { de: "Maschine", en: "Machine" },
  "set.machineHint": {
    de: "Pfad-Overrides für Chrome (browse_page), das Bild-Modell und das lokale Whisper-Modell (STT). Leer = automatische Erkennung bzw. Backend-Standard.",
    en: "Path overrides for Chrome (browse_page), the image model and the local whisper STT model. Empty = automatic discovery or the backend's own default.",
  },
  "set.chrome": { de: "Chrome-Binary", en: "Chrome binary" },
  "set.imageModel": { de: "Bild-Modell", en: "Image model" },
  "set.imageModelAuto": { de: "Standard des Backends", en: "backend default" },
  "set.sttModel": { de: "STT-Modell", en: "STT model" },

  // settings page — the way back to the built-in model's one-time notice
  // (card 144: every exit of the sheet dismisses it for good)
  "set.secLocalNotice": { de: "Eingebautes Modell", en: "Built-in model" },
  "set.localNoticeHint": {
    de: "Der einmalige Hinweis zu Stärken und Grenzen des eingebauten Modells. Jedes Schließen merkt er sich — hier kommt er auf Wunsch zurück.",
    en: "The one-time notice about the built-in model's strengths and limits. Any close dismisses it for good — this brings it back on request.",
  },
  "set.localNoticeShow": { de: "Hinweis wieder anzeigen", en: "Show the notice again" },

  // settings page — one-shot graduation banner (retiring the two localStorage
  // stores in favor of server-backed user settings)
  "set.gradTitle": {
    de: "Lokal gemerkte Standards in die User-Settings übernehmen?",
    en: "Adopt locally remembered defaults into your user settings?",
  },
  "set.gradApply": { de: "Übernehmen", en: "Adopt" },
  "set.gradDiscard": { de: "Verwerfen", en: "Discard" },

  // resizer
  "rz.expand": { de: "Ausklappen", en: "Expand" },
  "rz.handle": { de: "Ziehen: Größe · Klick: einklappen", en: "Drag to resize · click to collapse" },
  "rz.ariaExpand": { de: "{label} ausklappen", en: "Expand {label}" },
  "rz.ariaHandle": {
    de: "{label}: ziehen zum Skalieren, Klick zum Einklappen",
    en: "{label}: drag to resize, click to collapse",
  },

  // chat
  "chat.you": { de: "Du", en: "You" },
  "chat.error": { de: "Fehler", en: "Error" },
  "chat.sendAgain": { de: "Nochmal senden", en: "Send again" },
  "chat.emptyTitle": { de: "frag spectroscope.", en: "ask spectroscope." },
  "chat.emptyTag": {
    de: "Der Agent liest Dateien, führt Tools aus und streamt hier jeden Schritt seiner Arbeit.",
    en: "The agent reads files, runs tools, and streams every step of its work here.",
  },
  "chat.emptyHint": {
    de: "Tipp: Das Zahnrad oben wechselt das Design (auch spectro white) und stellt die Partikel ein.",
    en: "Tip: the gear up top switches the design (spectro white included) and tunes the particles.",
  },
  "img.noKey": { de: "kein Key in .env", en: "no key in .env" },
  "chat.recording": { de: "Aufnahme {t}", en: "Recording {t}" },
  // The tooltip is the only place ⌘V is discoverable — a paste affordance
  // nobody is told about is a paste affordance nobody uses.
  "chat.attach": {
    de: "Bild anhängen (hineinziehen oder mit ⌘V einfügen)",
    en: "Attach an image (drag one in, or paste with ⌘V)",
  },
  "chat.attachAria": { de: "Bild anhängen", en: "Attach image" },
  "chat.attachedAria": { de: "Angehängte Bilder", en: "Attached images" },
  "chat.attachRemove": { de: "{name} entfernen", en: "Remove {name}" },
  /* A clipboard blob can arrive without a name; the thumbnail says what it is
     rather than leaving the remove label dangling. */
  "chat.attachPasted": { de: "Eingefügtes Bild", en: "Pasted image" },
  "chat.attachFailed": {
    de: "Dieses Bild konnte nicht gelesen werden.",
    en: "That image could not be read.",
  },
  "chat.attachTooMany": {
    de: "Mehr als {n} Bilder pro Nachricht gehen nicht.",
    en: "No more than {n} images per message.",
  },
  // Card 183: the composer's slash completion. The invocation is a SENTENCE
  // the reader can see and edit, not a hidden instruction — a skill is
  // instructions in the system prompt, so asking for it by name is all there is
  // to do, and doing it visibly is what lets the reader disagree.
  "slash.invocation": { de: "Nutze den Skill {skill} hierfür:", en: "Use the {skill} skill for this:" },
  "slash.title": { de: "Skills", en: "Skills" },
  "slash.none": { de: "Kein Skill passt zu „{query}\u201c", en: "No skill matches \u201c{query}\u201d" },
  "slash.empty": { de: "Keine Skills installiert", en: "No skills installed" },
  "slash.hint": {
    de: "↑↓ wählen · Enter übernehmen · Esc schließen",
    en: "↑↓ to move · Enter to pick · Esc to dismiss",
  },
  "slash.disabledNote": {
    de: "Abgeschaltete Skills stehen nicht in der Liste — der Agent kennt sie nicht.",
    en: "Disabled skills are not listed; the agent has not been told about them.",
  },
  "chat.placeholder": { de: "Nachricht an den Agenten …", en: "Message the agent …" },
  "chat.running": { de: "Läuft …", en: "Running …" },
  "chat.send": { de: "Senden", en: "Send" },
  "chat.stop": { de: "Stopp", en: "Stop" },
  "chat.stopping": { de: "Stoppt …", en: "Stopping …" },
  "chat.stopAria": { de: "Laufenden Lauf stoppen", en: "Stop the running turn" },
  "chat.queue": { de: "Einreihen", en: "Queue" },
  "chat.queuedHint": { de: "startet nach dem laufenden Lauf", en: "sends after the current run" },
  "chat.unqueue": { de: "Aus der Warteschlange nehmen", en: "Remove from queue" },
  // Names the row that holds export and translate, above the input. A group of
  // two buttons with no name is two loose buttons to a screen reader.
  "chat.tools": { de: "Sitzungs-Werkzeuge", en: "session tools" },
  "disc.title": { de: "Anzeigetiefe", en: "disclosure level" },
  "tf.extended": { de: "vollständig", en: "extended" },
  "tf.extendedTitle": {
    de: "Alles zeigen, was das Protokoll trägt — auch den zusammengebauten Request (System-Prompt, Tool-Schemas, Conversation), die Token-Wahrheit, Turn-Grenzen und den Plan.",
    en: "Show everything the record carries — the assembled request (system prompt, tool schemas, conversation), the token truth, turn boundaries and the plan.",
  },

  "width.title": { de: "Textbreite", en: "text width" },
  "width.normal": { de: "normal", en: "normal" },
  "width.normal.hint": { de: "die gewohnte Lesebreite", en: "the usual reading width" },
  "width.wide": { de: "breit", en: "wide" },
  "width.wide.hint": { de: "30 % mehr Platz als Maximum", en: "30% more room as the maximum" },
  "disc.normal.hint": { de: "Thinking und Tools eingeklappt", en: "thinking and tools collapsed" },
  "disc.extended.hint": {
    de: "alles aufgeklappt: Thinking + Tool-Ein-/Ausgaben",
    en: "everything expanded: thinking + tool input/output",
  },
  "disc.thinking.hint": { de: "nur Thinking-Blöcke aufgeklappt", en: "only thinking blocks expanded" },
  "chat.thinkingLive": { de: "denkt …", en: "thinking …" },
  "chat.chars": { de: "{n} Zeichen", en: "{n} chars" },
  "tr.button": { de: "Übersetzung", en: "translation" },
  "tr.buttonTitle": {
    de: "Die lesbaren Teile dieser Session übersetzen",
    en: "Translate the readable parts of this session",
  },
  "tr.title": { de: "Übersetzung", en: "translation" },
  "tr.lede": {
    de: "spectroscope übersetzt, was jemand in dieser Session geschrieben oder gelesen hat: deine Nachrichten und die Antworten. Tool-Aufrufe, Tool-Ausgaben, Dateipfade und Codeblöcke bleiben im Original. Die Session selbst bleibt unverändert — das Original steht neben der Übersetzung.",
    en: "Translates what a person wrote or read in this session: your messages and the answers. Tool calls, tool output, file paths and code blocks stay in the original. The session itself is not changed — the original stays right next to the translation.",
  },
  "tr.engine.local": { de: "das eingebaute Modell", en: "the built-in model" },
  "tr.engine.local.body": {
    de: "Läuft auf diesem Rechner. Der Text geht an niemanden.",
    en: "Runs on this machine. The text goes to no one.",
  },
  "tr.engine.cloud": { de: "der konfigurierte Provider", en: "the configured provider" },
  "tr.engine.cloud.body": {
    de: "Schneller und meist besser, und es geht auf deinen Key. Die Textstellen verlassen diesen Rechner.",
    en: "Faster and usually better, and it spends your key. The passages leave this machine.",
  },
  "tr.engine.choose": { de: "wählen", en: "use this one" },
  "tr.engine.chosen": { de: "gewählt", en: "chosen" },
  "tr.out.noBinary": {
    de: "Kein llama-server in dieser Installation — die Desktop-App bringt einen mit, sonst llama.cpp installieren.",
    en: "No llama-server on this install — the desktop app bundles one, otherwise install llama.cpp.",
  },
  "tr.out.noModel": {
    de: "Noch kein eingebautes Modell auf der Platte — im Provider-Picker eins herunterladen.",
    en: "No built-in model on disk yet — download one from the provider picker.",
  },
  "tr.out.needsKey": {
    de: "Der konfigurierte Provider hat keinen Key.",
    en: "The configured provider has no key.",
  },
  "tr.out.providerIsLocal": {
    de: "Der konfigurierte Provider ist das eingebaute Modell — in den Einstellungen einen Cloud-Provider wählen oder lokal übersetzen.",
    en: "The configured provider is the built-in model — pick a cloud provider in Settings, or translate locally.",
  },
  "tr.out.generic": { de: "In dieser Installation nicht verfügbar.", en: "Not available on this install." },
  "tr.enginesFailed": {
    de: "Der Server ließ sich nicht fragen, welche Engines verfügbar sind ({msg}).",
    en: "Could not ask the server which engines are available ({msg}).",
  },
  "tr.target": { de: "nach", en: "into" },
  "tr.run": { de: "{n} Textstellen übersetzen", en: "translate {n} passages" },
  "tr.stop": { de: "stopp", en: "stop" },
  "tr.stopped": { de: "Gestoppt. Was zurückkam, steht unten.", en: "Stopped. What came back is below." },
  "tr.nothing": {
    de: "In dieser Session ist noch nichts Lesbares.",
    en: "Nothing readable in this session yet.",
  },
  "tr.dropped": {
    de: "{n} weitere Textstellen sind nicht dabei — diese Session ist länger als ein Übersetzungslauf.",
    en: "{n} further passages are not included — this session is longer than one translation run.",
  },
  "tr.result": { de: "Übersetzung", en: "translation" },
  "tr.progress": { de: "{done} von {total}", en: "{done} of {total}" },
  "tr.honesty": {
    de: "maschinelle Übersetzung des aufgezeichneten Textes — das Original steht darüber",
    en: "machine translation of the recorded text — the original stays above it",
  },
  "tr.failed": { de: "Übersetzung fehlgeschlagen: {msg}", en: "Translation failed: {msg}" },
  "tr.failedPassage": {
    de: "Diese Textstelle ließ sich nicht übersetzen: {msg}",
    en: "This passage did not translate: {msg}",
  },
  "tr.kind.prompt": { de: "Nachricht", en: "message" },
  "tr.kind.answer": { de: "Antwort", en: "answer" },
  "tr.original": { de: "Original", en: "original" },
  "trace.cols": { de: "Spalten", en: "columns" },
  "trace.colsAria": { de: "Optionale Trace-Spalten", en: "Optional trace columns" },
  "trace.colsHostTitle": {
    de: "Host-Spalte ein- oder ausblenden — die Gegenstelle im Netz je Frame.",
    en: "Show or hide the host column — the network counterpart of each frame.",
  },
  "trace.colsModelTitle": {
    de: "Modell-Spalte ein- oder ausblenden — das Modell, das den jeweiligen Run bedient.",
    en: "Show or hide the model column — the model serving each run.",
  },
  "trace.face": { de: "Ansicht", en: "view" },
  "trace.faceAria": { de: "Ansicht für aufgeklappte Frames", en: "View for expanded frames" },
  "trace.faceHint": {
    de: "Legt fest, in welcher Ansicht Frames aufklappen. Umschalten holt alle Zeilen auf diese Ansicht zurück; einzelne Zeilen kannst du danach weiter umschalten.",
    en: "Sets which view frames open in. Switching it brings every row back to that view; a single row can still be switched afterwards.",
  },
  "trace.faceTitle.structured": {
    de: "Frames als das aufklappen, was sie sind — ein Aufruf als seine Tool-Karte, eine Antwort als ihr Text.",
    en: "Open frames as the thing they are — a call as its tool card, an answer as its text.",
  },
  "trace.faceTitle.insight": {
    de: "Frames als aufgeklappten Baum aufklappen.",
    en: "Open frames as an expanded tree.",
  },
  "trace.faceTitle.compact": {
    de: "Frames hervorgehoben und umgebrochen aufklappen: der ganze Inhalt im Bild, ohne seitliches Scrollen.",
    en: "Open frames highlighted and wrapped: the whole content on screen, no sideways scrolling.",
  },
  "trace.faceTitle.wire": {
    de: "Frames als reinen Text aufklappen: genau die Zeilen, die über den Draht gingen, je eine Zeile.",
    en: "Open frames as plain text: exactly the lines that crossed the wire, one row each.",
  },
  "trace.faceTitle.source": {
    de: "Frames mit der Zeile der importierten Datei aufklappen, aus der sie gelesen wurden.",
    en: "Open frames with the line of the imported file they were read from.",
  },

  // The source pane (card: the source line). One sentence per case and never a
  // shared one: this card exists because one label meant two things. "There is
  // no file" alone is four different statements, and the byte-for-byte promise
  // is only the one about a frame this app wrote down itself.
  "trace.source.none": {
    de: "Diese Sitzung ist hier entstanden, es gibt also keine getrennte Quelle. Die Draht-Zeile ist die gespeicherte Zeile, Byte für Byte.",
    en: "This session was produced here, so there is no separate source. The wire line is the stored line, byte for byte.",
  },
  // The same session, while a translation is on screen. The first half still
  // holds; the second one cannot, because the wire face is rendering a payload
  // the translator rebuilt and the stored line still has the original words.
  "trace.source.noneTranslated": {
    de: "Diese Sitzung ist hier entstanden, es gibt also keine getrennte Quelle. Die Draht-Zeile zeigt gerade die Übersetzung, nicht die gespeicherte Zeile.",
    en: "This session was produced here, so there is no separate source. The wire line is showing the translation right now, not the stored line.",
  },
  "trace.source.unstored": {
    de: "Die gespeicherte Sitzung enthält diesen Frame nicht. Die App hat ihn für das Bild gebaut oder über den Socket geschickt, und beides wird nicht in die Datei geschrieben.",
    en: "The stored session does not contain this frame. The app built it for the screen or sent it over the socket, and neither of those is written to the file.",
  },
  "trace.source.scenario": {
    de: "Das ist ein kompiliertes Szenario. Der Browser hat diese Frames aus dem Skript gebaut, es gibt also weder eine Datei noch eine Draht-Zeile dahinter.",
    en: "This is a compiled scenario. The browser built these frames from its script, so there is no file and no wire line behind them.",
  },
  "trace.source.fleet": {
    de: "Diesen Frame hat ein anderer Prozess erzeugt. Diese App schaut nur zu: was dieser Node gespeichert hat, bleibt bei ihm.",
    en: "Another process produced this frame. This app is only watching: whatever that node wrote down stays with the node.",
  },
  "trace.source.built": {
    de: "Diesen Frame hat der Import gebaut. Keine einzelne Zeile der Datei hat ihn erzeugt.",
    en: "The importer built this frame. No single line of the file produced it.",
  },
  "trace.source.missing": {
    de: "Dieser Frame zeigt auf Zeile {n}, die diese Datei nicht hat. Sie zählt {total} Zeilen.",
    en: "This frame points at line {n}, which this file does not have. It counts {total} lines.",
  },
  "trace.source.line": { de: "Zeile {n} von {total}.", en: "Line {n} of {total}." },
  "trace.source.shared": {
    de: "Zeile {n} von {total}. Sie hat {k} Frames erzeugt; dies ist Frame {i}.",
    en: "Line {n} of {total}. It produced {k} frames; this is frame {i}.",
  },
  "trace.source.notJson": {
    de: "Diese Zeile ist kein JSON. Sie steht unverändert da.",
    en: "This line is not JSON. It stands here unchanged.",
  },
  "trace.source.capped": {
    de: "{shown} von {total} Zeichen im Bild. Kopieren nimmt immer die ganze Zeile.",
    en: "Showing {shown} of {total} characters. Copying always takes the whole line.",
  },
  "trace.source.showAll": { de: "Rest laden", en: "Load the rest" },
  // The same ceiling and the same two numbers one face over, where the copy
  // button hands over the payload rather than the line — so the second half is
  // the escape that is actually next to it. Measured over 83,214 thinking
  // blocks in ~/.claude/projects, exactly one is long enough to read this.
  "trace.meta.capped": {
    de: "{shown} von {total} Zeichen im Bild. Der ganze Wert ist einen Klick entfernt.",
    en: "Showing {shown} of {total} characters. The whole value is one click away.",
  },
  // A signature or a base64 body: carried whole, collapsed on screen, and never
  // dropped without saying so.
  // The two collapsed kinds (readable.ts HIDDEN_KINDS), which are two claims
  // and not one. `hidden` is a signature or a base64 body: bytes, at any
  // length. `long` is one run of characters too long to read where it stands,
  // and measured over 4639 transcripts most of those are language, so the byte
  // sentence over one of them was the pane saying something the value flatly
  // was not. Both open on request and neither is ever dropped.
  "trace.source.hidden": { de: "{n} Zeichen, die kein Text sind", en: "{n} characters that are not text" },
  "trace.source.long": { de: "{n} Zeichen, eingeklappt", en: "{n} characters, collapsed" },
  "trace.source.show": { de: "Zeigen", en: "Show" },
  "trace.source.hide": { de: "Wieder einklappen", en: "Collapse again" },
  "trace.readingAria": { de: "Lesart", en: "Reading" },
  "trace.reading.verbatim": { de: "Wörtlich", en: "Verbatim" },
  "trace.reading.readable": { de: "Lesbar", en: "Readable" },
  "trace.readingTitle.verbatim": {
    de: "Die Bytes zeigen, wie sie in der Datei stehen. Das ist die Voreinstellung und wird nicht gespeichert.",
    en: "Show the bytes as they stand in the file. This is the default and it is not remembered.",
  },
  "trace.readingTitle.readable": {
    de: "Verschachtelte Dokumente aufschlagen und echte Zeilenumbrüche zeigen. Das ist eine Deutung der Zeile, nicht die Zeile.",
    en: "Open embedded documents and show real line breaks. This is a reading of the line, not the line.",
  },
  "search.regexTitle": { de: "Als regulären Ausdruck lesen", en: "Read as a regular expression" },
  "tr.applied": {
    de: "Die Übersetzung landet gleichzeitig in allen Ansichten dieser Session — Chat, Trace, Text-Feed und Lab lesen denselben Stream.",
    en: "The translation lands in every view of this session at once — chat, trace, text feed and lab all read the same stream.",
  },
  "tr.plan": {
    de: "{u} Textstellen, zerlegt in {n} Aufrufe, die ins Modell passen.",
    en: "{u} passages of text, cut into {n} calls that fit the model.",
  },
  "tr.running": {
    de: "Läuft im Hintergrund weiter. Du kannst dieses Panel schließen, ohne den Lauf zu beenden.",
    en: "Running in the background. Closing this sheet leaves it running.",
  },
  "tr.done": {
    de: "Fertig. Alle Ansichten zeigen jetzt die Übersetzung; „Original“ schaltet zurück.",
    en: 'Done. Every view now shows the translation; "original" switches back.',
  },
  "tr.failedUnits": {
    de: "{n} Textstellen sind in der Originalsprache geblieben.",
    en: "{n} passages stayed in the original language.",
  },
  "tr.cutShort": {
    de: "Der Übersetzungslauf endete vorzeitig. {n} Textstellen sind in der Originalsprache geblieben.",
    en: "The translation run ended early. {n} passages stayed in the original language.",
  },
  "tr.thinking": { de: "das Denken mitübersetzen", en: "also translate the reasoning" },
  "tr.cost": { de: "ungefähr {w} Wörter.", en: "about {w} words." },
  "tr.costExact": { de: "{c} Zeichen insgesamt", en: "{c} characters in total" },
  "tr.thinkingIn": {
    de: "Das Denken ist dabei: {n} Aufrufe mehr, ungefähr {w} Wörter.",
    en: "The reasoning is included: {n} more calls, about {w} words.",
  },
  "tr.thinkingOut": {
    de: "Das Denken bleibt in der Originalsprache.",
    en: "The reasoning stays in its original language.",
  },
  "tr.export": { de: "als .jsonl speichern", en: "save as .jsonl" },
  "tr.exportTitle": {
    de: "Die übersetzte Session als Datei — beim nächsten Mal laden statt neu übersetzen",
    en: "The translated session as a file — load it next time instead of translating again",
  },
  "tr.reset": { de: "Übersetzung verwerfen", en: "discard the translation" },
  "tv.mcp": { de: "MCP-Tool", en: "MCP tool" },
  "tv.agents": { de: "Subagenten", en: "Subagents" },
  "tv.agentsN": { de: "{n} Agenten", en: "{n} agents" },
  "tv.plan": { de: "Plan", en: "Plan" },
  "tv.steps": { de: "{n} Schritte", en: "{n} steps" },
  // The heading is the verb, because the row under it is the same row for all
  // three: a number, a state, a subject, each drawn only when the call had it.
  "tv.taskCreated": { de: "Aufgabe angelegt", en: "Task created" },
  "tv.taskUpdated": { de: "Aufgabe geändert", en: "Task updated" },
  "tv.tasks": { de: "Aufgaben", en: "Tasks" },
  "tv.tasksN": { de: "{n} Aufgaben", en: "{n} tasks" },
  "tv.taskBlockedBy": { de: "wartet auf {ids}", en: "waiting on {ids}" },
  // Not "unchanged": the call did ask for a state, and what the result reports
  // is that the list did not move for it.
  "tv.taskUnchanged": {
    de: "das Ergebnis nennt kein Feld: nichts hat sich bewegt",
    en: "the result named no field: nothing moved",
  },
  "tv.question": { de: "Frage", en: "Question" },
  "tv.questionsN": { de: "{n} Fragen", en: "{n} questions" },
  "tv.optionsN": { de: "{n} Optionen", en: "{n} options" },
  "tv.multiSelect": { de: "Mehrfachauswahl", en: "multiple choice" },
  "tv.chosen": { de: "gewählt", en: "chosen" },
  "tv.answer": { de: "Antwort", en: "Answer" },
  // An asked question that never got an answer says so. Silence here would read
  // as though nothing had been asked.
  "tv.unanswered": { de: "nicht beantwortet", en: "not answered" },
  "tv.dismissed": { de: "ohne Auswahl geschlossen", en: "closed without choosing" },
  "tv.fetch": { de: "Geladen", en: "Fetched" },
  "tv.search": { de: "Web-Suche", en: "Web search" },
  "tv.noPreview": {
    de: "nicht im Bildspeicher, daher keine Vorschau",
    en: "not in the image store, so no preview here",
  },
  "tv.imageGone": { de: "Bild nicht verfügbar", en: "image unavailable" },
  "trace.mode.structured": { de: "Struktur", en: "Structured" },
  "ed.nothing": {
    de: "Dieser Frame trägt nichts außer seinem Typ.",
    en: "This frame carries nothing beyond its type.",
  },
  "ed.more": { de: "+{n} weitere", en: "+{n} more" },
  "ed.fromFile": {
    de: "Aus der importierten Zeile — die Felder des Records selbst, unverändert. Die Abschnitte darüber sind das, was diese Zeile erzeugt hat.",
    en: "From the imported line — the record's own fields, verbatim. The sections above are what this line produced.",
  },
  "exp.button": { de: "exportieren", en: "export" },
  "exp.title": { de: "Diese Ansicht exportieren", en: "Export this view" },
  "exp.emptyTitle": {
    de: "Noch nichts zu exportieren — diese Ansicht trägt keine Events.",
    en: "Nothing to export yet — this view carries no events.",
  },
  "exp.htmlChat": { de: "Chat als HTML", en: "chat as HTML" },
  "exp.htmlText": { de: "Text-Feed als HTML", en: "text feed as HTML" },
  "exp.htmlHint": {
    de: "Eine Datei, alles darin, genau so wie du sie gerade liest. Öffnet auch ohne Netz.",
    en: "One self-contained file, exactly as you are reading it. Opens with the network unplugged.",
  },
  "exp.jsonl": { de: "Events als JSONL", en: "events as JSONL" },
  "exp.jsonlHint": {
    de: "{n} Events im Wire-Format, das der Import wieder einliest.",
    en: "{n} events in the wire format the import reads back.",
  },
  "search.title": { de: "In der Ansicht suchen", en: "Find in view" },
  "search.placeholder": { de: "Suchen …", en: "Find …" },
  "search.noMatches": { de: "keine Treffer", en: "no matches" },
  "search.of": { de: "Treffer {n} von {total}", en: "hit {n} of {total}" },
  "search.prev": { de: "Vorheriger Treffer", en: "Previous match" },
  "search.next": { de: "Nächster Treffer", en: "Next match" },

  // per-surface search readouts. Both surfaces search only what they render, so
  // both say where their edge is — a 0 that means "filtered away" must not read
  // as "not in this session".
  "trace.searchScope": {
    de: "Gesucht wird in den Zeilen, die der Filter durchlässt, und nur in den eingeblendeten Spalten. Was der Filter versteckt, wird gezählt und genannt — verschluckt wird nichts.",
    en: "Search runs over the rows the filter lets through, and only over the columns on screen. Whatever the filter hides is counted and named — nothing is swallowed.",
  },
  "trace.searchNone": { de: "keine Treffer", en: "no matches" },
  "trace.searchAt": { de: "Treffer {i} von {n}", en: "hit {i} of {n}" },
  "trace.searchHidden": { de: "· {n} hinter dem Filter", en: "· {n} behind the filter" },
  "tf.searchScope": {
    de: "gesucht wird nur, was hier steht — mit „vollständig“ kommt der ganze Request dazu",
    en: 'only what is on screen is searched — "extended" brings in the whole request',
  },
  "chat.cacheRead": { de: "aus dem Cache", en: "cache read" },
  "chat.cacheWrite": { de: "in den Cache", en: "cache write" },
  "chat.usageTitle": {
    de: "Tokens dieser Antwort (rein · Cache · raus), wie lange sie gedauert hat und welches Modell sie geschrieben hat",
    en: "This answer's tokens (in · cache · out), how long it took, and the model that wrote it",
  },
  "chat.historyAria": { de: "Verlauf des Agenten-Laufs", en: "Agent run history" },
  "info.spawned": { de: "Subagent {id} gestartet: {task}", en: "Subagent {id} spawned: {task}" },
  "info.compacted": {
    de: "Verlauf kompaktiert: {n} Turns zusammengefasst",
    en: "History compacted: {n} turns summarized",
  },
  "info.compactedInto": {
    de: "Verlauf kompaktiert: {n} Turns zu {chars} Zeichen zusammengefasst",
    en: "History compacted: {n} turns summarized into {chars} characters",
  },

  // built-in model first-use notice (card 91; per-model since the catalogue)
  "lmn.title": {
    de: "eingebautes modell — läuft auf dieser maschine",
    en: "built-in model — runs on this machine",
  },
  "lmn.lede": {
    de: "{model} läuft komplett lokal: kein Key, kein Konto, keine Cloud. Nichts, was du tippst, verlässt deinen Rechner.",
    en: "{model} runs entirely on this machine: no key, no account, no cloud. Nothing you type leaves your computer.",
  },
  "lmn.goodTitle": { de: "gut für", en: "good for" },
  "lmn.limitsTitle": { de: "ehrliche Grenzen", en: "honest limits" },
  "lmn.limits.noTools": {
    de: "keine Tools (dieses Modell spricht das Tool-Protokoll nicht), bescheidene Qualität und Kontextgröße — Antworten können danebenliegen.",
    en: "no tools (this model does not speak the tool protocol), modest quality and context — answers can be off.",
  },
  "lmn.limits.local": {
    de: "ein lokales Modell in dieser Größe bleibt unter den Cloud-Modellen: einfachere Antworten, kleinerer Kontext. Tools funktionieren.",
    en: "a local model this size stays below the cloud models: simpler answers, a smaller context. Tools do work.",
  },
  "lmn.limits.generic": {
    de: "ein lokales Modell in dieser Größe bleibt unter den Cloud-Modellen: einfachere Antworten, kleinerer Kontext — Antworten können danebenliegen.",
    en: "a local model this size stays below the cloud models: simpler answers, a smaller context — answers can be off.",
  },
  "lmn.real": {
    de: "Mehr Tiefe: oben im Picker einen Cloud-Anbieter wählen — oder im Chooser ein größeres Modell.",
    en: "For more depth, pick a cloud provider in the header — or a larger model in the chooser.",
  },
  "lmn.gotIt": { de: "Verstanden", en: "Got it" },

  // built-in model chooser (the catalogue dialog)
  "lm.eyebrow": { de: "eingebautes modell", en: "built-in model" },
  "lm.title": { de: "Lokales Modell wählen", en: "Choose a local model" },
  "lm.intro": {
    de: "Diese laufen komplett auf dieser Maschine. Kein Key, kein Konto, keine Cloud — jeder Download ist auf seine sha256 gepinnt, und jede Zeile nennt Lizenz und Quelle.",
    en: "These run entirely on this machine. No key, no account, no cloud — every download is pinned to its sha256, and each row names its licence and source.",
  },
  "lm.loadFailed": {
    de: "Der Katalog konnte nicht geladen werden.",
    en: "The catalogue could not be loaded.",
  },
  "lm.retry": { de: "Nochmal versuchen", en: "Try again" },
  "lm.startRefused": {
    de: "Der Download konnte nicht gestartet werden — der Server hat abgelehnt oder ist nicht erreichbar.",
    en: "The download could not be started — the server refused it or is unreachable.",
  },
  "lm.noBinary": {
    de: "Auf diesem Rechner ist kein llama-server gefunden worden. Die Desktop-App bringt einen mit; beim Server-Jar installierst du ihn selbst: brew install llama.cpp",
    en: "No llama-server was found on this machine. The desktop app carries one; with the server jar you install it yourself: brew install llama.cpp",
  },
  "lm.loading": { de: "Katalog wird geladen …", en: "Loading the catalogue …" },
  "lm.default": { de: "Standard", en: "default" },
  "lm.ready": { de: "geladen", en: "on disk" },
  "lm.toolsYes": { de: "arbeitet mit Tools", en: "works with tools" },
  "lm.toolsNo": { de: "nur Chat, keine Tools", en: "chat only, no tools" },
  "lm.thinkYes": { de: "zeigt sein Denken", en: "shows its thinking" },
  "lm.fit.ok": { de: "passt auf diese Maschine", en: "fits this machine" },
  "lm.fit.tight": { de: "passt, wird aber knapp", en: "fits, but it will be tight" },
  "lm.fit.ram": {
    de: "braucht mehr Speicher, als diese Maschine hat",
    en: "needs more memory than this machine has",
  },
  "lm.fit.disk": { de: "zu wenig freier Plattenplatz", en: "not enough free disk space" },
  "lm.fit.unknown": {
    de: "Speicher/Platte nicht lesbar — Prüfung entfällt",
    en: "memory/disk unreadable — the check is skipped",
  },
  "lm.licence": { de: "Lizenz", en: "licence" },
  "lm.source": { de: "Download-Quelle", en: "download source" },
  "lm.download": { de: "{size} herunterladen", en: "Download {size}" },
  "lm.downloading": { de: "lädt …", en: "downloading …" },
  "lm.use": { de: "{model} verwenden", en: "Use {model}" },
  "lm.failed": { de: "Download fehlgeschlagen", en: "Download failed" },
  "lm.close": { de: "Schließen", en: "Close" },

  // catalogue copy, one blurb + one good-for line per model (ids from local/models.json)
  "local.model.qwen3-1-7b.goodFor": {
    de: "schnelle Antworten auf schwacher Hardware",
    en: "quick answers on light machines",
  },
  "local.model.qwen3-1-7b.blurb": {
    de: "Die kleinste Wahl. Schnell selbst auf 8-GB-Maschinen, versteht Tools und denkt vor der Antwort. Tauscht Tiefe gegen Tempo.",
    en: "The smallest choice. Fast even on 8 GB machines, understands tools, and thinks before it answers. Trades depth for speed.",
  },
  "local.model.qwen3-4b.goodFor": {
    de: "Alltag und kleine Agenten-Aufgaben",
    en: "everyday chat and small agent tasks",
  },
  "local.model.qwen3-4b.blurb": {
    de: "Der Standard, und der einzige Mittelweg, der beides kann: es denkt sichtbar nach UND ruft Tools auf, und passt bequem in 8 GB Speicher.",
    en: "The default, and the middle ground that does both: it thinks visibly AND calls tools, and fits comfortably in 8 GB of memory.",
  },
  "local.model.qwen2-5-coder-7b.goodFor": {
    de: "Code und Agenten-Arbeit mit Tools",
    en: "coding and tool-driven agent work",
  },
  "local.model.qwen2-5-coder-7b.blurb": {
    de: "Gebaut für Code und präzise Anweisungen, und der stärkste Tool-Aufrufer hier. Kein Denk-Kanal: es antwortet direkt, im Trace ist also nichts zu sehen als die Tool-Aufrufe.",
    en: "Built for code and precise instructions, and the strongest tool caller here. No thinking channel: it answers directly, so the trace shows the tool calls and nothing before them.",
  },
  "local.model.qwen3-8b.goodFor": {
    de: "die tiefsten Antworten, ab 16 GB",
    en: "the deepest answers, on 16 GB machines",
  },
  "local.model.qwen3-8b.blurb": {
    de: "Die größte Wahl. Bestes Reasoning im Feld und voller Tool-Support, will aber eine Maschine mit 16 GB oder mehr.",
    en: "The largest choice. Best reasoning of the set and full tool support, but it wants a machine with 16 GB or more.",
  },
  "local.model.vibethinker-3b.goodFor": {
    de: "einem Modell beim Denken zusehen, ohne Tools",
    en: "watching a model think, without tools",
  },
  "local.model.vibethinker-3b.blurb": {
    de: "Ein kleiner Reasoning-Spezialist. Zeigt sein Denken schön, kann aber keine Tools aufrufen; der Agent antwortet nur mit Worten.",
    en: "A small reasoning specialist. Shows its thinking beautifully but cannot call tools, so the agent answers with words only.",
  },
  "local.model.vibethinker-3b.licenceCaveat": {
    de: "Die Lizenz des Basismodells (Qwen2.5-Coder-3B) erlaubt Forschungs- und Evaluationsnutzung. Die GGUF-Datei ist eine Community-Requantisierung (mradermacher), nicht von WeiboAI selbst — du lädst sie eigenhändig, sha256-gepinnt.",
    en: "Its base model's licence (Qwen2.5-Coder-3B) allows research and evaluation use. The GGUF is a community requantization (mradermacher) rather than WeiboAI's own file — you fetch it yourself, sha256-pinned.",
  },

  // Named after the file it hands over, not after the act: the tools row one
  // line above carries "exportieren" / "export", which opens the format dialog
  // and writes the view on screen. Two neighbours reading "Export" would have
  // been one word for two different things (owner report, 2026-08-03).
  "arch.export": { de: ".jsonl herunterladen", en: "download .jsonl" },
  "arch.exportTitle": {
    de: "Die aufgezeichnete Datei, unverändert; der Import liest sie wieder ein",
    en: "The recorded file, unchanged; the import reads it back",
  },
  // The sidecar beside the session file: offered only when its index answered
  // non-empty, so the link never promises a file that is not there.
  "arch.llmWire": { de: "llm wire", en: "llm wire" },
  "arch.llmWireTitle": {
    de: "Die neben dieser Session aufgezeichneten LLM-Austausche, als NDJSON — jede Zeile mit ihrer Aufzeichnungstreue gekennzeichnet",
    en: "The LLM exchanges recorded beside this session, as NDJSON — every line labeled with its fidelity",
  },

  // tool card views (card 94)
  "tv.modeAria": { de: "Darstellung des Tool-Aufrufs", en: "Tool call view" },
  "tv.mode.structured": { de: "struktur", en: "structured" },
  "tv.mode.json": { de: "json", en: "json" },
  "tv.mode.raw": { de: "roh", en: "raw" },
  "tv.file": { de: "Datei", en: "File" },
  "tv.content": { de: "Inhalt", en: "Content" },
  "tv.wrote": { de: "Geschrieben", en: "Wrote" },
  "tv.edited": { de: "Bearbeitet", en: "Edited" },
  "tv.before": { de: "vorher", en: "before" },
  "tv.after": { de: "nachher", en: "after" },
  "tv.listing": { de: "Verzeichnis", en: "Directory" },
  "tv.matches": { de: "Suche", en: "Search" },
  "tv.command": { de: "Kommando", en: "Command" },
  "tv.output": { de: "Ausgabe", en: "Output" },
  "tv.input": { de: "Eingabe", en: "Input" },
  "tv.image": { de: "Bild", en: "Image" },
  "tv.skill": { de: "Skill", en: "Skill" },
  "tv.lines": { de: "{n} Zeilen", en: "{n} lines" },
  // Card 167: three things a Claude Code transcript records beside the text the
  // model was shown, and the card had no way to know before.
  "tv.truncatedCap": {
    de: "am Token-Limit abgeschnitten \u2014 das ist nicht die ganze Datei",
    en: "cut off at the token cap \u2014 this is not the whole file",
  },
  "tv.stderr": { de: "Standardfehler", en: "stderr" },
  "tv.landed": { de: "ge\u00e4ndert bei {at}", en: "changed at {at}" },
  "tv.entries": { de: "{n} Einträge", en: "{n} entries" },
  "tv.hits": { de: "{n} Treffer", en: "{n} hits" },
  "tv.workflow": { de: "Workflow", en: "Workflow" },
  "tv.phases": { de: "Phasen", en: "Phases" },
  "tv.phasesN": { de: "{n} Phasen", en: "{n} phases" },
  "tv.script": { de: "Skript", en: "Script" },
  "tv.args": { de: "Argumente", en: "Arguments" },
  // A workflow's run half. The launch is a receipt; the outcome arrives later as
  // its own message, and a card that cannot tell the two apart reads every
  // abandoned run as a finished one.
  "tv.outcome": { de: "Ergebnis", en: "Outcome" },
  "tv.returned": { de: "Zurückgegeben", en: "Returned" },
  "tv.wfOpen": { de: "gestartet · kein Ergebnis vermerkt", en: "launched · no outcome recorded" },
  "tv.wfFailed": {
    de: "der Start ist fehlgeschlagen, es lief kein Durchgang",
    en: "the launch failed, so no run was started",
  },
  // Both phrases are count-neutral by construction. A German "{n} kamen nicht
  // zurück" reads wrong at one, and one is the commonest number here — the
  // adjectival form is right for every count in both languages.
  "tv.wfUnnamed": {
    de: "im Ergebnis: {n} gescheitert, keiner davon benannt",
    en: "in the outcome: {n} failed, none of them named",
  },
  "tv.wfDead": { de: "· {n} gescheitert", en: "· {n} failed" },
  "tv.failures": { de: "Fehlschläge", en: "Failures" },
  "tv.failuresN": { de: "{n} ohne Rückmeldung", en: "{n} did not return" },
  // Interpolated from RunStat["key"] — every one of these is reachable only as
  // `tv.run.${key}`, so the i18n suite pins the family by name.
  "tv.run.agents": { de: "Agenten", en: "agents" },
  "tv.run.failed": { de: "gescheitert", en: "failed" },
  "tv.run.skipped": { de: "übersprungen", en: "skipped" },
  "tv.run.empty": { de: "ohne Ergebnis", en: "returned nothing" },
  "tv.run.tokens": { de: "Tokens", en: "tokens" },
  "tv.run.tools": { de: "Tool-Aufrufe", en: "tool calls" },
  "tv.run.elapsed": { de: "Dauer", en: "elapsed" },
  "tv.bodyAria": { de: "Darstellung des Datei-Inhalts", en: "File body view" },
  "tv.bodyText": { de: "text", en: "text" },
  "tv.bodyMd": { de: "markdown", en: "markdown" },
  // Says what the two faces cost each other. A markdown file opens rendered; the
  // text chip is what a reader takes when the bytes are the point.
  "tv.bodyHint": {
    de: "Text zeigt, was zurückkam, Zeichen für Zeichen. Die Markdown-Ansicht verbraucht die Zeichen, die es zu Markdown machen — Rauten, Pipes, Backticks — liest sich also besser und belegt weniger.",
    en: "Text shows what came back, character for character. The markdown face consumes the characters that make it markdown — the hashes, the pipes, the backticks — so it reads better and proves less.",
  },
  // Both stand above the body in either face: they are facts about this body, so
  // they still warn a reader who renders it anyway.
  "tv.mdIndent": {
    de: "Die Markdown-Ansicht behält die Einrückung dieser Zeilen nicht, deshalb öffnet der Inhalt als Text.",
    en: "The rendered face drops the indentation these lines carry, so this body opens as text.",
  },
  "tv.mdWord": {
    de: "Eine Hervorhebung wird hier mitten im Wort gepaart: die Markdown-Ansicht würde etwas hervorheben, das die Datei nicht hervorhebt. Deshalb öffnet der Inhalt als Text.",
    en: "Emphasis pairs into the middle of a word here, so the rendered face would mark a span the file does not. This body opens as text.",
  },
  "tv.pending": { de: "(noch kein Ergebnis)", en: "(no result yet)" },
  "tv.notJson": {
    de: "Die Ausgabe ist Text, kein JSON — hier im Original:",
    en: "This output is text, not JSON — shown verbatim:",
  },

  // skills + MCP managers (card 90)
  "skset.title": { de: "Skills", en: "Skills" },
  "skset.note": {
    de: "Skills aus ~/.spectro/skills und dem Projekt. Änderungen greifen im nächsten Chat.",
    en: "Skills from ~/.spectro/skills and the project. Changes apply to the next chat.",
  },
  "skset.empty": {
    de: "Keine Skills. Beim ersten Start werden die eingebauten hierher kopiert.",
    en: "No skills. The built-in ones are copied here on first start.",
  },
  "skset.enable": { de: "einschalten", en: "enable" },
  "skset.disable": { de: "ausschalten", en: "disable" },
  "skset.deleteTitle": { de: "Skill löschen (nur eigene)", en: "Delete skill (user skills only)" },
  "skset.deleteConfirm": { de: "wirklich?", en: "sure?" },

  // the bundled skill catalogue (card 182)
  "skset.catalogue": { de: "Katalog", en: "Catalogue" },
  "skset.catalogueNote": {
    de: "57 Skills aus vier Sammlungen, in dieser App mitgeliefert — ohne Netz. Ein Klick kopiert einen davon samt LICENSE nach ~/.spectro/skills/<Sammlung>/, der Agent ruft ihn als <Sammlung>:<Skill>. Es wird nichts ausgeführt, und ein eigener Skill gleichen Namens bleibt unangetastet.",
    en: "57 skills from four collections, carried inside this app — no network needed. One click copies one of them, with its LICENSE, into ~/.spectro/skills/<pack>/, and the agent calls it <pack>:<skill>. Nothing is executed, and a skill of your own with the same name is left alone.",
  },
  "skset.catalogueEmpty": {
    de: "Dieser Build trägt keinen Katalog.",
    en: "This build carries no catalogue.",
  },
  "skset.install": { de: "installieren", en: "install" },
  "skset.installing": { de: "kopiere …", en: "copying ..." },
  "skset.installed": { de: "installiert", en: "installed" },
  "skset.installTitle": {
    de: "Aus {pack}, Lizenz {licence} — LICENSE und PROVENANCE.json werden mitkopiert",
    en: "From {pack}, licensed {licence} — LICENSE and PROVENANCE.json travel with it",
  },
  "skset.installFailed": { de: "Installation fehlgeschlagen: {error}", en: "Install failed: {error}" },
  "skset.nameTaken": {
    de: "Dieser Skill ist schon installiert. Zum Neu-Installieren erst löschen — ein Kopieren darüber würde eigene Änderungen und den Aus-Schalter verlieren.",
    en: "This skill is already installed. Delete it first to install it again — copying over it would lose your edits and its off switch.",
  },

  "mcpset.title": { de: "MCP-Server", en: "MCP servers" },
  "mcpset.note": {
    de: "Externe MCP-Server (User-Ebene). Greifen beim nächsten Chat; der rohe JSON-Editor im Composer-Zahnrad bleibt für die Projekt-Ebene.",
    en: "External MCP servers (user scope). Apply to the next chat; the raw JSON editor in the composer gear stays for the project scope.",
  },
  "mcpset.empty": { de: "Keine MCP-Server konfiguriert.", en: "No MCP servers configured." },
  "mcpset.namePh": { de: "name", en: "name" },
  "mcpset.cmdPh": { de: "kommando + argumente", en: "command + args" },
  "mcpset.add": { de: "hinzufügen", en: "add" },
  "mcpset.remove": { de: "entfernen", en: "remove" },

  // microphone (voice input)
  "mic.record": { de: "Sprachnachricht aufnehmen", en: "Record a voice message" },
  "mic.stop": { de: "Aufnahme stoppen", en: "Stop recording" },
  "mic.transcribing": { de: "Transkribiere …", en: "Transcribing ..." },
  "mic.sttHint": {
    de: "Speech-to-Text ist nicht installiert — bash scripts/setup-stt.sh ausführen.",
    en: "Speech-to-text is not installed — run bash scripts/setup-stt.sh.",
  },

  // composer workspace gear (settings-productization Task 16)
  "wsg.title": {
    de: "Permission-Modus & Regeln für dieses Projekt",
    en: "Permission mode & rules for this project",
  },
  "wsg.header": { de: "Workspace-Settings", en: "Workspace settings" },
  "wsg.unpinned": {
    de: "Workspace anheften (Dateien-Tab), um Projekt-Settings zu entsperren",
    en: "Pin the workspace (Files tab) to unlock project settings",
  },
  "wsg.modeTitle": { de: "Permission-Modus", en: "Permission mode" },
  "wsg.mode.ask.hint": {
    de: "Fragt bei jedem gefährlichen Tool-Aufruf nach — außer eine Regel erlaubt ihn schon.",
    en: "Asks before every risky tool call — unless a rule already allows it.",
  },
  "wsg.mode.auto.hint": {
    de: "Erlaubt jeden Tool-Aufruf automatisch, ohne nachzufragen (Demo-Modus).",
    en: "Allows every tool call automatically, no questions asked (demo mode).",
  },
  "wsg.mode.readonly.hint": {
    de: "Lehnt jeden gefährlichen Tool-Aufruf automatisch ab — nichts verändert etwas.",
    en: "Denies every risky tool call automatically — nothing gets to change anything.",
  },
  "wsg.rules.title": { de: "Immer erlauben", en: "Always allow" },
  "wsg.rules.scope": { de: "[projekt]", en: "[project]" },
  "wsg.rules.empty": {
    de: "Noch keine Regeln — Tool-Aufrufe brauchen weiter deine Bestätigung.",
    en: "No rules yet — tool calls still need your approval.",
  },
  "wsg.rules.addPh": { de: "+ Regel hinzufügen …", en: "+ Add rule …" },
  "wsg.rules.removeAria": { de: "Regel entfernen: {rule}", en: "Remove rule: {rule}" },

  // composer gear: local overrides + MCP/hooks JSON editors (Task 17)
  "wsg.local.title": { de: "Lokale Overrides", en: "Local overrides" },
  "wsg.local.scope": { de: "[lokal]", en: "[local]" },
  "wsg.local.empty": { de: "Noch keine lokalen Overrides.", en: "No local overrides yet." },
  "wsg.local.removeAria": { de: "Override entfernen: {field}", en: "Remove override: {field}" },
  "wsg.local.fieldAria": { de: "Feld für den Override", en: "Override field" },
  "wsg.local.valuePh": { de: "Wert …", en: "Value …" },
  "wsg.local.add": { de: "+ Hinzufügen", en: "+ Add" },

  // The provenance line under the field picker: what the key is set to right
  // now, and which layer of the fold said so. {origin} is rendered by
  // originLabel() in state/serverSettings, which already speaks both languages.
  "wsg.local.now": { de: "Aktuell: {value}", en: "Now: {value}" },
  "wsg.local.nowOrigin": { de: "Aktuell: {value} · {origin}", en: "Now: {value} · {origin}" },
  "wsg.local.unset": { de: "nicht gesetzt", en: "not set" },
  "wsg.local.beats": {
    de: "Ein lokaler Override sticht diesen Wert — nur auf diesem Rechner.",
    en: "A local override beats that value — on this machine only.",
  },
  "wsg.local.setHere": {
    de: "Dieser Wert kommt bereits aus deinen lokalen Overrides.",
    en: "That value already comes from your local overrides.",
  },
  "wsg.local.valueAria": { de: "Wert für {field}", en: "Value for {field}" },
  "wsg.local.pick": { de: "— wählen —", en: "— pick one —" },
  "wsg.local.allowed": { de: "Erlaubt: {values}", en: "Allowed: {values}" },
  "wsg.local.known": { de: "Bekannte Werte: {values}", en: "Known values: {values}" },
  "wsg.local.numRule": { de: "Ganze Zahl, {min} oder größer", en: "Whole number, {min} or greater" },
  "wsg.local.numRuleFree": { de: "Ganze Zahl", en: "Whole number" },
  "wsg.local.freeText": { de: "Freier Text — keine feste Liste", en: "Free text — no fixed list" },

  // Refusals. Each names what is wrong with the value instead of just
  // rejecting it; parseLocalOverrideValue picks the key and fills the params.
  "wsg.local.err.blank": { de: "{field} braucht einen Wert.", en: "{field} needs a value." },
  "wsg.local.err.int": { de: "„{value}“ ist keine ganze Zahl.", en: "“{value}” is not a whole number." },
  "wsg.local.err.min": {
    de: "„{value}“ ist zu klein — erlaubt ist {min} oder größer.",
    en: "“{value}” is too small — {min} or greater is allowed.",
  },
  "wsg.local.err.max": {
    de: "„{value}“ ist zu groß — erlaubt ist {max} oder kleiner.",
    en: "“{value}” is too large — {max} or smaller is allowed.",
  },
  "wsg.local.err.bool": {
    de: "„{value}“ ist weder true noch false.",
    en: "“{value}” is neither true nor false.",
  },
  "wsg.local.err.enum": {
    de: "„{value}“ steht nicht zur Wahl. Erlaubt: {allowed}.",
    en: "“{value}” is not on the list. Allowed: {allowed}.",
  },

  // One line per overridable key: what it does, in the words of someone who
  // has to decide whether to touch it.
  "wsg.local.desc.provider": {
    de: "Welches LLM-Backend die Läufe fährt.",
    en: "Which LLM backend runs the session.",
  },
  "wsg.local.desc.model": {
    de: "Die Modell-ID beim gewählten Provider. Jeder Provider hat seine eigenen Namen.",
    en: "The model id at the chosen provider. Every provider names its own.",
  },
  "wsg.local.desc.baseUrl": {
    de: "Die Adresse für ollama und openai-kompatible Provider. Anthropic ignoriert sie.",
    en: "The address for ollama and OpenAI-compatible providers. Anthropic ignores it.",
  },
  "wsg.local.desc.thinking": {
    de: "Den Denk-Kanal des Modells mitschreiben und anzeigen.",
    en: "Stream and show the model's reasoning channel.",
  },
  "wsg.local.desc.imageProvider": {
    de: "Welches Backend generate_image benutzt.",
    en: "Which backend generate_image calls.",
  },
  "wsg.local.desc.imageModel": {
    de: "Bild-Modell statt des Backend-Defaults. Leer lassen heißt: Default nehmen.",
    en: "An image model instead of the backend's default. Unset means: take the default.",
  },
  "wsg.local.desc.maxRetries": {
    de: "Wie oft ein Provider-Aufruf nach einem Wackler wiederholt wird. 0 schaltet das ab.",
    en: "How often a provider call is retried after a hiccup. 0 turns retrying off.",
  },
  "wsg.local.desc.promptCaching": {
    de: "Anthropics Prompt-Caching. Bei ollama und openai passiert nichts.",
    en: "Anthropic prompt caching. Does nothing on ollama and openai.",
  },
  "wsg.local.desc.compactionThreshold": {
    de: "Ab wie vielen Input-Tokens der Kontext zusammengefasst wird.",
    en: "The input-token count at which the context gets summarized.",
  },
  "wsg.local.desc.sttModel": {
    de: "Pfad zur whisper.cpp-Modelldatei fürs Diktieren.",
    en: "Path to the whisper.cpp model file used for dictation.",
  },
  "wsg.json.mcpTitle": { de: "MCP-Server", en: "MCP servers" },
  "wsg.json.hooksTitle": { de: "Hooks", en: "Hooks" },
  "wsg.json.scope": { de: "[projekt · JSON]", en: "[project · JSON]" },
  "wsg.json.save": { de: "Speichern", en: "Save" },

  // usage footer
  "footer.run": { de: "Lauf", en: "run" },
  "footer.session": { de: "Session", en: "session" },
  "footer.subagent": { de: "inkl. 1 Subagent", en: "incl. 1 subagent" },
  "footer.subagents": { de: "inkl. {n} Subagenten", en: "incl. {n} subagents" },
  "footer.subagentsTitle": {
    de: "Der Session-Wert enthält die Subagenten: {out} out stammen von ihnen.",
    en: "The session figure includes the subagents: {out} out came from them.",
  },
  "footer.runSubagentsTitle": {
    de: "Der Lauf-Wert enthält die Subagenten: {out} out stammen von ihnen.",
    en: "The run figure includes the subagents: {out} out came from them.",
  },
  "footer.runActive": { de: "Lauf aktiv", en: "run active" },
  "footer.stopped": { de: "gestoppt · {r}", en: "stopped · {r}" },
  "footer.ready": { de: "bereit", en: "ready" },
  "footer.connected": { de: "verbunden", en: "connected" },
  "footer.connecting": { de: "verbinde …", en: "connecting" },
  "footer.disconnected": { de: "getrennt", en: "disconnected" },

  // connection banner
  "conn.connecting": {
    de: "Verbinde mit dem spectroscope-Server …",
    en: "Connecting to the spectroscope server ...",
  },
  "conn.lost": { de: "Verbindung getrennt", en: "Connection lost" },
  "conn.retryIn": { de: "neuer Versuch in {s} s", en: "retrying in {s} s" },
  "conn.retryNow": { de: "Jetzt neu verbinden", en: "Reconnect now" },

  // image gallery
  "img.title": { de: "Bilder", en: "Images" },
  "img.aria": { de: "Generierte Bilder", en: "Generated images" },
  "img.close": { de: "Bild-Panel schließen", en: "Close image panel" },
  "img.copy": { de: "→ Workspace", en: "→ Workspace" },
  "img.copied": { de: "✓ Kopiert", en: "✓ Copied" },
  "img.copyTitle": {
    de: "Kopiert das Bild in den Workspace dieser Session — Dateiname frei wählbar",
    en: "Copies the image into this session's workspace — pick any file name",
  },
  "img.copyPrompt": {
    de: "Dateiname im Workspace (ohne Endung wird die originale ergänzt):",
    en: "File name in the workspace (the original extension is added if missing):",
  },
  "img.copyFailed": { de: "Kopieren fehlgeschlagen.", en: "Copy failed." },
  "img.empty": {
    de: "Bitte den Agenten, ein Bild zu generieren.",
    en: "Ask the agent to generate an image.",
  },
  "img.openFull": { de: "In voller Größe in neuem Tab öffnen", en: "Open full size in a new tab" },

  // graph node kinds
  "gk.user": { de: "Prompt", en: "Prompt" },
  "gk.turn": { de: "Turn", en: "Turn" },
  "gk.tool": { de: "Tool", en: "Tool" },
  "gk.subagent": { de: "Subagent", en: "Subagent" },
  "gk.answer": { de: "Antwort", en: "Answer" },

  // header extras
  "hdr.imagesShow": { de: "Bilder anzeigen", en: "Show images" },
  "hdr.imagesHide": { de: "Bilder ausblenden", en: "Hide images" },
  "hdr.settings": { de: "Einstellungen", en: "Settings" },

  // relative time (sidebar meta)
  "time.now": { de: "gerade eben", en: "just now" },
  "time.min": { de: "vor {n} min", en: "{n} min ago" },
  "time.h": { de: "vor {n} h", en: "{n} h ago" },
  "time.d": { de: "vor {n} d", en: "{n} d ago" },

  // import extras
  "imp.pasted": { de: "eingefügte Session", en: "pasted session" },

  // session delete (archive bar)
  "arch.delete": { de: "Löschen", en: "Delete" },
  "arch.deleteConfirm": { de: "Wirklich löschen?", en: "Really delete?" },
  "arch.deleteTitle": {
    de: "Diese Session endgültig löschen (JSONL-Datei + Anhänge) — zweiter Klick bestätigt",
    en: "Delete this session for good (JSONL file + attachments) — a second click confirms",
  },

  // session resume
  "arch.resume": { de: "Session fortsetzen", en: "Resume session" },
  "arch.resumeTitle": {
    de: "Diese Session wieder aufnehmen: der ganze Verlauf wird beim nächsten Prompt wieder ans LLM hochgeladen",
    en: "Pick this session back up: the whole history is re-uploaded to the LLM with your next prompt",
  },
  "hdr.resumed": { de: "Fortgesetzt", en: "Resumed" },
  // An import is not an archive. It came from another tool's file and lives
  // only in this tab; calling it "Archive" made it indistinguishable from a
  // session this machine produced and stored.
  "hdr.imported": { de: "Importiert", en: "Imported" },
  "trace.resumeSummary": {
    de: "{e} Events geladen · ~{t} Tokens Verlauf gehen mit dem nächsten Request wieder hoch (plus System-Prompt & Tool-Schemas obendrauf)",
    en: "{e} events loaded · ~{t} tokens of history ride along with the next request (plus system prompt & tool schemas on top)",
  },
  "trace.resumeRowTitle": {
    de: "an die LLM · der Verlauf wird beim nächsten Request wieder hochgeladen (UI-Marker, kein Wire-Event)",
    en: "to the LLM · the history is re-uploaded with the next request (UI marker, not a wire event)",
  },
  "trace.resumeNote": {
    de: "UI-Marker, kein Wire-Event: Session fortgesetzt. Alles oberhalb ist der alte Verlauf; er wird beim NÄCHSTEN Request als messages[] wieder mit hochgeladen (siehe danach context_info/usage).",
    en: "UI marker, not a wire event: session resumed. Everything above is the old history; it is re-uploaded as messages[] with the NEXT request (watch context_info/usage right after).",
  },

  // lab JSONL strip
  "lt.meta": { de: "{a} angewendet · {q} wartend", en: "{a} applied · {q} waiting" },
  "lt.earlier": { de: "… {n} frühere Zeilen", en: "… {n} earlier lines" },
  "lt.dam": { de: "▮▮ Damm · {n} wartend", en: "▮▮ dam · {n} waiting" },
  "lt.moreWaiting": { de: "… {n} weitere wartend", en: "… {n} more waiting" },

  // leveling: the tutorial (card 80). Level names come from the ids, so only the
  // blurbs and the criteria need words here.
  "leveling.level.darkFrame.name": { de: "Dunkelbild", en: "dark frame" },
  "leveling.level.darkFrame.blurb": {
    de: "Einen Provider einrichten und Szenarien anschauen.",
    en: "Set up a provider and watch scenarios.",
  },
  "leveling.level.firstLight.name": { de: "Erstes Licht", en: "first light" },
  "leveling.level.firstLight.blurb": {
    de: "Einen Agenten laufen lassen und seine Antwort lesen.",
    en: "Run an agent and read its answer.",
  },
  "leveling.level.theTrace.name": { de: "Die Spur", en: "the trace" },
  "leveling.level.theTrace.blurb": {
    de: "Nachlesen, was wirklich passiert ist.",
    en: "Read what actually happened.",
  },
  "leveling.level.theGate.name": { de: "Das Tor", en: "the gate" },
  "leveling.level.theGate.blurb": {
    de: "Entscheiden, was der Agent darf.",
    en: "Decide what the agent may do.",
  },
  "leveling.level.thePrism.name": { de: "Das Prisma", en: "the prism" },
  "leveling.level.thePrism.blurb": {
    de: "Einen Lauf in seine einzelnen Linien auffächern.",
    en: "Split one run into many lines.",
  },
  "leveling.level.theFleet.name": { de: "Die Flotte", en: "the fleet" },
  "leveling.level.theFleet.blurb": {
    de: "Agenten über Prozessgrenzen hinweg beobachten.",
    en: "Watch agents across processes.",
  },
  "leveling.level.deepField.name": { de: "Tiefenfeld", en: "deep field" },
  "leveling.level.deepField.blurb": {
    de: "Das Instrument nach außen richten.",
    en: "Point the instrument outward.",
  },

  "leveling.criterion.providerReady.label": { de: "Provider bereit", en: "provider ready" },
  "leveling.criterion.providerReady.counts": {
    de: "Einen Provider einrichten, oder einfach loslaufen lassen.",
    en: "Set up a provider, or simply get a run to come back.",
  },
  "leveling.criterion.firstRunComplete.label": { de: "Erster Lauf", en: "first run" },
  "leveling.criterion.firstRunComplete.counts": {
    de: "Einen Agenten laufen lassen, bis er fertig ist.",
    en: "Let an agent run all the way through.",
  },
  "leveling.criterion.sessionReopened.label": { de: "Session geöffnet", en: "session reopened" },
  "leveling.criterion.sessionReopened.counts": {
    de: "Eine gespeicherte Session aus der Liste öffnen.",
    en: "Open a stored session from the list.",
  },
  "leveling.criterion.traceOpened.label": { de: "Spur gelesen", en: "trace read" },
  "leveling.criterion.traceOpened.counts": {
    de: "Den Trace einer Session ansehen, in der ein Tool lief.",
    en: "Look at the trace of a session where a tool ran.",
  },
  "leveling.criterion.replayScrubbed.label": { de: "Replay bewegt", en: "replay scrubbed" },
  "leveling.criterion.replayScrubbed.counts": {
    de: "Den Replay-Regler bewegen oder Schritt für Schritt gehen.",
    en: "Move the replay scrubber, or step through.",
  },
  "leveling.criterion.disclosureExpanded.label": { de: "Aufgeklappt", en: "expanded" },
  "leveling.criterion.disclosureExpanded.counts": {
    de: "Einen Thinking-Block oder eine Tool-Karte aufklappen.",
    en: "Expand a thinking block or a tool card.",
  },
  "leveling.criterion.modeSet.label": { de: "Modus gesetzt", en: "mode set" },
  "leveling.criterion.modeSet.counts": {
    de: "Einen Berechtigungsmodus bewusst wählen.",
    en: "Choose a permission mode deliberately.",
  },
  "leveling.criterion.gateAnswered.label": { de: "Tor beantwortet", en: "gate answered" },
  "leveling.criterion.gateAnswered.counts": {
    de: "Eine echte Berechtigungsfrage erlauben oder ablehnen.",
    en: "Allow or deny one real permission request.",
  },
  "leveling.criterion.fanoutWatched.label": { de: "Fächer gesehen", en: "fan-out watched" },
  "leveling.criterion.fanoutWatched.counts": {
    de: "Im Spektrum eine Session mit zwei oder mehr Agenten ansehen.",
    en: "View a session with two or more agents in the spectrum.",
  },
  "leveling.criterion.lensUsed.label": { de: "Linse benutzt", en: "lens used" },
  "leveling.criterion.lensUsed.counts": {
    de: "Die Reasoning- oder Timeline-Linse einschalten.",
    en: "Switch on the reasoning or timeline lens.",
  },
  "leveling.criterion.labStepped.label": { de: "Labor gesteppt", en: "lab stepped" },
  "leveling.criterion.labStepped.counts": {
    de: "Im Labor mindestens einmal steppen oder abspielen.",
    en: "Step or play in the lab at least once.",
  },
  "leveling.criterion.fleetEntered.label": { de: "Flotte betreten", en: "fleet entered" },
  "leveling.criterion.fleetEntered.counts": { de: "Eine Flotte betreten.", en: "Enter a fleet." },
  "leveling.criterion.machineRoomOpened.label": { de: "Maschinenraum", en: "machine room" },
  "leveling.criterion.machineRoomOpened.counts": {
    de: "Den Maschinenraum einer Flotte ansehen.",
    en: "View a fleet's machine room.",
  },
  "leveling.criterion.explainRun.label": { de: "Deutung geholt", en: "explain used" },
  "leveling.criterion.explainRun.counts": {
    de: "Einen Lauf vom Modell deuten lassen.",
    en: "Have a run read back by the model.",
  },
  "leveling.criterion.otlpProbeGreen.label": { de: "OTLP grün", en: "OTLP green" },
  "leveling.criterion.otlpProbeGreen.counts": {
    de: "Einen OTLP-Endpunkt eintragen und vom Doctor prüfen lassen.",
    en: "Point at an OTLP endpoint and let the doctor check it.",
  },
  "leveling.criterion.sessionImported.label": { de: "Session importiert", en: "session imported" },
  "leveling.criterion.sessionImported.counts": {
    de: "Eine fremde .jsonl laden.",
    en: "Load a foreign .jsonl.",
  },
  "leveling.criterion.starterScaffolded.label": { de: "Starter erzeugt", en: "starter scaffolded" },
  "leveling.criterion.starterScaffolded.counts": {
    de: "Ein Starter-Projekt in einen Ordner schreiben.",
    en: "Scaffold a starter project into a folder.",
  },
  "leveling.criterion.fleetActed.label": { de: "Flotte gesteuert", en: "fleet driven" },
  "leveling.criterion.fleetActed.counts": {
    de: "Einen echten Node starten, stoppen oder sein Tor beantworten.",
    en: "Spawn, stop or gate a real node.",
  },

  // leveling: the UI around it
  "leveling.pill.title": {
    de: "Stand: {name} — klicken für das Tutorial",
    en: "At {name} — click for the tutorial",
  },
  "leveling.panel.title": { de: "Das Tutorial", en: "The tutorial" },
  "leveling.panel.at": { de: "Dein Stand: {name}", en: "You are at {name}" },
  "leveling.panel.toward": {
    de: "{met} von {total} zum nächsten Schritt",
    en: "{met} of {total} toward the next step",
  },
  "leveling.panel.reached": { de: "erreicht", en: "reached" },
  "leveling.panel.mastery": { de: "Kür — schaltet nichts frei", en: "mastery — unlocks nothing" },
  "leveling.panel.byHand": { de: "von Hand markiert", en: "marked by hand" },
  "leveling.panel.observedHere": { de: "beobachtet, ohne Session", en: "observed, no session" },
  "leveling.panel.evidence": { de: "Beleg ansehen", en: "see the evidence" },
  "leveling.panel.tickByHand": { de: "Von Hand abhaken", en: "Tick by hand" },
  "leveling.openAll": { de: "Alles öffnen", en: "Open everything" },
  "leveling.openAll.note": {
    de: "Öffnet jede Fläche sofort und dauerhaft. Der Fortschritt läuft weiter mit, nur ohne Schlösser.",
    en: "Opens every surface at once and for good. Progress keeps tracking, just without locks.",
  },
  "leveling.teaser.what": { de: "Was das ist", en: "What this is" },
  "leveling.teaser.unlocks": { de: "Öffnet sich, sobald: {what}", en: "Opens once you have: {what}" },
  "leveling.levelUp.title": { de: "{name} erreicht", en: "{name} reached" },
  "leveling.levelUp.opened": { de: "Neu offen: {surfaces}", en: "Now open: {surfaces}" },
  "leveling.intro.title": { de: "Willkommen bei spectroscope", en: "Welcome to spectroscope" },
  "leveling.intro.body": {
    de: "spectroscope hat sieben Tabs, drei Linsen, eine Flotten-Canvas und einen Maschinenraum. Alles auf einmal ist eine Wand. Das Tutorial macht daraus einen Weg: du fängst mit dem Chat an, und jede weitere Fläche geht auf, sobald du die davor benutzt hast.",
    en: "spectroscope has seven tabs, three lenses, a fleet canvas and a machine room. All at once, that is a wall. The tutorial turns it into a path: you start with the chat, and each further surface opens once you have used the one before it.",
  },
  "leveling.intro.honest": {
    de: "Kein Zwang: du kannst jederzeit alles öffnen, in den Einstellungen oder direkt an jeder verschlossenen Fläche.",
    en: "Nothing is forced: you can open everything at any moment, in the settings or right on any closed surface.",
  },
  "leveling.intro.ladder": { de: "Mit dem Tutorial anfangen", en: "Start with the tutorial" },
  "leveling.intro.everything": { de: "Alles sofort öffnen", en: "Open everything now" },
  "leveling.intro.foot": {
    de: "Diese Frage kommt nur einmal. Ändern kannst du es später in den Einstellungen.",
    en: "This question is asked once. You can change it later in the settings.",
  },
  "leveling.settings.title": { de: "Tutorial", en: "Tutorial" },
  "leveling.settings.mode": { de: "Modus", en: "Mode" },
  "leveling.settings.mode.ladder": {
    de: "Tutorial — Flächen öffnen sich nach und nach",
    en: "Tutorial — surfaces open as you go",
  },
  "leveling.settings.mode.checklist": {
    de: "Checkliste — nichts ist gesperrt, Fortschritt zählt mit",
    en: "Checklist — nothing locks, progress still counts",
  },
  "leveling.settings.mode.off": {
    de: "Aus — kein Pill, kein Panel, keine Aufzeichnung",
    en: "Off — no pill, no panel, no tracking",
  },
  "leveling.settings.reset": { de: "Zurück zum Dunkelbild", en: "Back to the dark frame" },
  "leveling.settings.reset.confirm": {
    de: "Alle Markierungen und der Verlauf werden gelöscht. Der Modus bleibt.",
    en: "Every mark and the history go. The mode stays.",
  },

  // about — a licence notice, so these read as terms rather than as copy. The
  // English is the repository's own wording (LICENSE-ASSETS.md); the German
  // states the same conditions and grants nothing the English does not.
  "about.open": { de: "Über", en: "About" },
  "about.title": { de: "Über spectroscope", en: "About spectroscope" },
  "about.tagline": { de: "Agent-Orchestrator", en: "agent orchestrator" },
  "about.licences": { de: "Lizenzen", en: "Licenses" },
  "about.codeLabel": { de: "Code", en: "Code" },
  "about.code": {
    de: "Der Code steht unter der MIT-Lizenz. Der Copyright-Vermerk reist mit jeder Kopie.",
    en: "The code is MIT licensed. The copyright notice travels with copies.",
  },
  "about.imagesLabel": { de: "Bilder", en: "Images" },
  "about.images": {
    de: "Screenshots, Diagramme und das Banner stehen unter CC BY 4.0. Du darfst sie teilen und bearbeiten, auch kommerziell, unter einer Bedingung: Namensnennung.",
    en: "Screenshots, diagrams and the banner are licensed CC BY 4.0. You may share and adapt them, including commercially, under one condition: attribution.",
  },
  "about.attributionLabel": {
    de: "Diese Zeile genügt als Namensnennung:",
    en: "A line like this is enough:",
  },
  "about.attributionCondition": {
    de: "Wer die Namensnennung entfernt, verliert damit die Lizenz an dem Material.",
    en: "Removing the attribution removes your license to use the material.",
  },
  "about.marksLabel": { de: "Logo und Wortmarke", en: "Logo and wordmark" },
  "about.fontsLabel": { de: "Schriften", en: "Fonts" },
  "about.marks": {
    de: "Logo, Icon und Wortmarke von spectroscope fallen nicht unter die CC-BY-Lizenz; alle Rechte vorbehalten. Sie bezeichnen dieses Projekt. Du darfst sie zeigen, wenn du dich auf spectroscope beziehst; du darfst mit ihnen kein abgeleitetes oder fremdes Produkt kennzeichnen und sie nicht so verwenden, dass sie eine Befürwortung oder eine Verbindung nahelegen.",
    en: "The spectroscope logo, icon and wordmark are not covered by the CC BY grant; all rights reserved. They identify this project. You may show them when referring to spectroscope; you may not use them to brand a derived or unrelated product, and you may not present them in a way that implies endorsement or affiliation.",
  },
  "about.repo": { de: "Repository", en: "Repository" },
  "about.openTitle": { de: "Version, Lizenzen und Copyright", en: "Version, licenses and copyright" },

  // state graph — the view over a run's two artifacts. Three families are
  // interpolated rather than written out, so a value added to the runtime
  // without its word would ship as the bare key: sg.st.<Lifecycle>,
  // sg.marker.<Marker["kind"]> and sg.omitted.<Marker["omitted"]>.
  "sg.claim": {
    de: "Die Topologie steht bei compile() fest, vor dem ersten Token — der Graph wird zuerst gezeichnet, der Ereignisstrom beleuchtet ihn nur. Beobachten, ohne anzufassen.",
    en: "The topology is fixed at compile(), before the first token — so the graph is drawn first and the event stream only lights it up. Observe without touching.",
  },
  "sg.horizontal": { de: "horizontal", en: "horizontal" },
  "sg.vertical": { de: "vertikal", en: "vertical" },
  "sg.load": { de: "Datei laden …", en: "load file …" },
  "sg.demo": { de: "Beispiel-Lauf ansehen", en: "look at the reference run" },
  "sg.scenarios": { de: "oder ein Szenario laden — echte Läufe der Engine", en: "or load a scenario — real runs of the engine" },
  // The empty pane. It says "nothing is loaded", never "loading": a topology is
  // fixed at compile() and arrives as a file, so there is nothing on its way.
  "sg.empty.title": { de: "Kein Graph geladen", en: "No graph loaded" },
  "sg.empty.why": {
    de: "Diese Ansicht wartet nicht auf etwas, sie hat nichts. Ein StateGraph steht bei compile() fest und wird als Dateipaar neben dem Lauf abgelegt — ohne dieses Paar gibt es keine Topologie zu zeichnen.",
    en: "This view is not waiting for something to arrive, it has nothing. A StateGraph is fixed at compile() and lands beside the run as a pair of files — without that pair there is no topology to draw.",
  },
  "sg.empty.pair": {
    de: "Das Paar heißt <stem>.graph.jsonl für die Form und <stem>.state.jsonl für die Werte. Die Form allein genügt; die Werte sind optional.",
    en: "The pair is <stem>.graph.jsonl for the shape and <stem>.state.jsonl for the values. The shape alone is enough; the values are optional.",
  },
  "sg.empty.orphanState": {
    de: "Das war eine .state.jsonl allein. Werte brauchen eine Form — lade die passende .graph.jsonl dazu.",
    en: "That was a .state.jsonl on its own. Values need a shape — load the matching .graph.jsonl with it.",
  },
  "sg.rewind": { de: "erster Datensatz", en: "first record" },
  "sg.play": { de: "abspielen (Leertaste)", en: "play (space)" },
  "sg.pause": { de: "anhalten (Leertaste)", en: "pause (space)" },
  "sg.speed": { de: "Abspielgeschwindigkeit", en: "replay speed" },
  "sg.instant": { de: "sofort", en: "instant" },
  "sg.scrub": { de: "Zeitleiste der Datensätze", en: "record timeline" },
  "sg.complete": { de: "vollständig", en: "complete" },
  "sg.inFlight": { de: "mitten im Lauf", en: "mid-run" },
  "sg.currentRecord": { de: "aktueller Datensatz", en: "current record" },
  "sg.record": { de: "Datensatz", en: "record" },
  "sg.node": { de: "Knoten", en: "node" },
  "sg.superstep": { de: "Superstep", en: "superstep" },
  "sg.branches": { de: "Verzweigungen, bekannt seit compile()", en: "branches, known at compile()" },
  "sg.branchesWhy": {
    de: "Jede Kante bleibt auf der Fläche, auch die nicht genommene. Sie verschwindet nicht, sie tritt zurück — genau das unterscheidet diese Ansicht von einer Spur.",
    en: "Every edge stays on the canvas, the untaken one included. It does not disappear, it steps back — that is what separates this view from a trace.",
  },
  "sg.nodeDetail": { de: "Knoten im Detail", en: "node detail" },
  // "Lebenszyklus", never "Zustand": a reader who sees "Zustand" expects values
  // and gets a status chip. sg.state below is the one that carries values.
  "sg.lifecycle": { de: "Lebenszyklus", en: "lifecycle" },
  "sg.rank": { de: "Rang", en: "rank" },
  "sg.duration": { de: "Dauer", en: "duration" },
  "sg.bytes": { de: "Bytes", en: "bytes" },
  "sg.entered": { de: "betreten", en: "entered" },
  "sg.updateKeys": { de: "geschriebene Kanäle", en: "channels written" },
  "sg.state": { de: "Zustand", en: "state" },
  "sg.noState": {
    de: "Keine .state.jsonl geladen — die Form ist vollständig, nur die Werte fehlen.",
    en: "No .state.jsonl loaded — the shape is complete, only the values are missing.",
  },
  "sg.clipped": { de: "gekürzt", en: "clipped" },
  "sg.notRecorded": { de: "nicht aufgezeichnet", en: "not recorded" },
  // The documents strip: the entries a list channel kept, per visit. The count
  // is the recorder's own truth — kept out of how many there were.
  "sg.documents": { de: "Dokumente", en: "documents" },
  "sg.kept": { de: "{n} von {m} behalten", en: "{n} of {m} kept" },
  "sg.item": { de: "{n} Eintrag", en: "{n} item" },
  "sg.items": { de: "{n} Einträge", en: "{n} items" },
  "sg.source": { de: "Quelle", en: "source" },
  "sg.nodes": { de: "Knoten", en: "nodes" },
  "sg.edges": { de: "Kanten", en: "edges" },
  "sg.supersteps": { de: "Supersteps", en: "supersteps" },
  "sg.noStateFile": { de: "keine .state.jsonl", en: "no .state.jsonl" },
  "sg.badLines": { de: "{n} Zeilen waren kein JSON", en: "{n} lines were not JSON" },
  "sg.misfiled": {
    de: "{n} Datensätze lagen in der falschen Datei",
    en: "{n} records sat in the wrong file",
  },
  "sg.offline": { de: "offline · keine Netzwerkaufrufe", en: "offline · no network calls" },
  // The four lifecycle words. "nie betreten" and "fertig" must stay
  // distinguishable in one glance: a run that never reached a node is a
  // different fact from one that reached it and wrote nothing.
  "sg.st.pending": { de: "nie betreten", en: "never entered" },
  "sg.st.active": { de: "läuft", en: "running" },
  "sg.st.done": { de: "fertig", en: "done" },
  "sg.st.error": { de: "Fehler", en: "error" },
  // The export sheet (net-new view): two total files, no options — so every
  // string here says what a file IS, not what a switch would do.
  "sg.thread": { de: "Thread", en: "thread" },
  "sg.export.close": { de: "Schließen", en: "close" },
  "sg.export.download": { de: "herunterladen", en: "download" },
  "sg.export.svg": { de: "Zeichnung als SVG", en: "drawing as SVG" },
  "sg.export.svgHint": {
    de: "Der Graph am aktuellen Datensatz — Knoten, Kanten, Rang-Beschriftungen. Eine Datei, keine externen Verweise.",
    en: "The graph at the current record — nodes, edges, rank labels. One file, no external references.",
  },
  "sg.export.md": { de: "Lauf-Zusammenfassung als Markdown", en: "run summary as Markdown" },
  "sg.export.mdHint": {
    de: "Quelle, Run- und Thread-Identität, Zähler und die Knoten-Tabelle — zum Einfügen in ein Ticket.",
    en: "Source, run and thread identity, the counts and the node table — ready to paste into a ticket.",
  },
  "sg.marker.str": { de: "gekürzter Text", en: "clipped text" },
  "sg.marker.list": { de: "gekürzte Liste", en: "clipped list" },
  "sg.marker.redacted": { de: "geschwärzt", en: "redacted" },
  "sg.marker.unserializable": { de: "nicht serialisierbar", en: "unserializable" },
  "sg.marker.channel": { de: "Kanal über der Grenze", en: "channel over the cap" },
  "sg.omitted.cap": { de: "an der Kanal-Grenze", en: "at the channel cap" },
  "sg.omitted.error": { de: "beim Serialisieren gescheitert", en: "serialization failed" },
  "sg.omitted.recordCap": { de: "an der Datensatz-Grenze", en: "at the record cap" },
};

/** Chrome string for `key` in `lang`; `{var}` placeholders fill from `vars`.
 *  Unknown keys pass through unchanged — a missing entry shows its key, loudly. */
export function t(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const entry = dict[key];
  let s = entry ? entry[lang] : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  }
  return s;
}
