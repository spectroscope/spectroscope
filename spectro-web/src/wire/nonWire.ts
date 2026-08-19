// The frames that are ours and never the file's.
//
// events.ts is the shared contract with the Java core and the Python edition,
// and it is additive by design: every reducer ignores a type it does not know.
// What none of the three readers do is PASS one through. Measured against
// jackson-databind 2.22.1: `RunEvent` is a sealed interface with @JsonSubTypes
// and no defaultImpl, so an unknown type raises InvalidTypeIdException, and
// SessionStore.readSessionEvents catches that as a torn line and drops it
// without a word. The Python edition pins the same result
// (test_wire.py::test_unknown_type_is_dropped). So a frame that is not in the
// union is readable here and invisible everywhere else.
//
// Two kinds of frame live outside the union, for two different reasons:
//
//   SOCKET-ONLY. What the running app tells its own UI about the backend, the
//   workspace, the permission mode, a resumed session, the OTLP mirror and an
//   attached hub. They ride the socket, they never enter a session file, and
//   the Text tab's JSONL view has always dropped them because that view IS the
//   file. SessionConnection says so in its own javadoc for every one of them,
//   in one repeated sentence: "socket-only UI frame ... never appended to the
//   JSONL". wireOnly.drift.test.ts reads that file and holds this list to it,
//   because the first version of this list was written from memory and named
//   three of the six.
//
//   IMPORT-ONLY. What somebody else's transcript records around the
//   conversation: the todo list, the prompt queue, the file that was edited
//   (card 141). They are readings of another format, in the idiom
//   import/sourceNotes.ts already uses. Nothing in the Java core would ever
//   emit one, so putting them in the union would ship a record no code path
//   constructs.
//
// WHY THE LIST IS SHARED. It was not, and the two writers disagreed: the Text
// tab filtered these types out of its view while the download wrote them, so
// exporting an imported transcript produced a file whose first line the Java
// reader silently dropped. One list, imported by every writer, is what keeps
// the view and the bytes saying the same thing.

// WHY THE TWO GROUPS ARE NAMED SEPARATELY. They are one rule for a writer and
// two different sentences for a reader. The export sheet counts a stream's
// non-wire frames and prints what the file will not carry; "4 frames read
// around the conversation" and "1 socket frame the app built for its own
// screen" are two facts a person acts on differently, and a sheet that merged
// them would be back to a number with no meaning attached.

/** What the running app tells its own UI, over the socket. SessionConnection
 *  says it of each one in the same words, "socket-only UI frame ... never
 *  appended to the JSONL": the workspace, the provider, the permission mode,
 *  the OTLP mirror (card 137) and the two frames an attached hub sends. Plus
 *  the session_resume marker the reducer builds on resume, which is the same
 *  kind of thing arriving from the other side.
 *
 *  They reach a download by the ordinary live path: ws.ts buffers whatever
 *  parses and App appends the whole batch, so a session exported while an
 *  endpoint or a hub was configured used to carry them into the file. */
export const SOCKET_ONLY_TYPES: ReadonlySet<string> = new Set([
  "provider_info",
  "workspace_info",
  "permission_mode_info",
  "session_resume",
  "otlp_export",
  "fleet_roster",
  "fleet_event",
  // `llm_exchange` USED to be here, and the reason it was is exactly the reason
  // it no longer is: a session file that carried it would have been a line the
  // Java reader drops as torn, because the sealed union had no such type. Card
  // 184 leg 3 gave it one, so the file can hold it and a reopened session can
  // finally say that a model was called at all. The drift guard next door is
  // what noticed the moment the two facts disagreed.
  //
  // The two below stay socket-only: they are leg 2's live frames, not RunEvents,
  // and the request half exists precisely to be seen BEFORE there is anything to
  // record.
  "llm_request",
  "llm_response",
  // Card 212. Both are facts about the SERVER at this instant, not about this
  // session's history: which sessions are live right now, and that a resume was
  // refused because another socket holds the id. Neither belongs in a file that
  // somebody reopens tomorrow — a stored "these two were live" would be a claim
  // about a machine that has since restarted. Additive on the socket, and
  // fenced out of every writer here, which is how the RunEvent wire stays
  // byte-frozen while the UI learns something new.
  "live_sessions",
  "session_busy",
  // Card 267. What this session is FOR, and the command that decides it: a
  // property of the session right now, not a line of its history. The verdict
  // IS history and rides the union as `goal_check`, so exactly one of the two
  // is here. Caught by the drift guard next door, which is what it is for.
  "goal_info",
]);

/** What an import read out of somebody else's transcript: the todo list, the
 *  prompt queue, the file that was edited (card 141), every prompt of the
 *  session after the first, what a tool actually returned before the client
 *  flattened it into the text the model read, and what a launch record says
 *  about the child it launched — the model it ran on, and whether it ever
 *  reported back (card 167), and the ground the run stood on — the working
 *  directory, the git branch and the client version, announced off the first
 *  line that says them and again at every move.
 *
 *  user_message is also the browser's own outbound frame (a ClientMessage,
 *  never a RunEvent), but an outbound one never enters the array a tab folds:
 *  recordOutgoing puts it in the trace and the bubble comes from the run_start
 *  that answers it. Inbound, it is only ever something an importer read. */
export const IMPORT_ONLY_TYPES: ReadonlySet<string> = new Set([
  "user_message",
  "task_reminder",
  "queue_operation",
  "queued_command",
  "edited_text_file",
  "tool_result_detail",
  "agent_detail",
  "ground_info",
  "attachment_image",
]);

/** Every frame type that must never reach a written session file. */
export const NON_WIRE_TYPES: ReadonlySet<string> = new Set([...SOCKET_ONLY_TYPES, ...IMPORT_ONLY_TYPES]);

/** True for a frame the wire format can carry, which is the only thing a
 *  writer may put in a file. */
export function isWireEvent(event: { type: string }): boolean {
  return !NON_WIRE_TYPES.has(event.type);
}
