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
]);

/** What an import read out of somebody else's transcript: the todo list, the
 *  prompt queue, the file that was edited (card 141), and every prompt of the
 *  session after the first.
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
]);

/** Every frame type that must never reach a written session file. */
export const NON_WIRE_TYPES: ReadonlySet<string> = new Set([...SOCKET_ONLY_TYPES, ...IMPORT_ONLY_TYPES]);

/** True for a frame the wire format can carry, which is the only thing a
 *  writer may put in a file. */
export function isWireEvent(event: { type: string }): boolean {
  return !NON_WIRE_TYPES.has(event.type);
}
