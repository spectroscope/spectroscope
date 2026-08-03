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
//   workspace, the permission mode, and a resumed session. They ride the
//   socket, they never enter a session file, and the Text tab's JSONL view has
//   always dropped them because that view IS the file.
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

/** Every frame type that must never reach a written session file. */
export const NON_WIRE_TYPES: ReadonlySet<string> = new Set([
  // socket-only, built by the running app
  "provider_info",
  "workspace_info",
  "permission_mode_info",
  "session_resume",
  // import-only, read out of a foreign transcript (card 141)
  "task_reminder",
  "queue_operation",
  "queued_command",
  "edited_text_file",
]);

/** True for a frame the wire format can carry, which is the only thing a
 *  writer may put in a file. */
export function isWireEvent(event: { type: string }): boolean {
  return !NON_WIRE_TYPES.has(event.type);
}
