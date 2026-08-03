# 03 — watch an embedded run in the cockpit

The five-lines facade hands you the event stream and nothing else. It does
not write a session file and it does not export anywhere — the stream is
yours. That is a feature: an embedded library should not scatter files
behind your back.

Recording is therefore explicit, and it is one line:

```java
var store = new SessionStore();      // mints an id under ~/.spectro/sessions
var sink  = new JsonlSink(store);

for (RunEvent event : agent.run("Write hello.txt with a short greeting")) {
    sink.onEvent(event);             // the tee
    System.out.println(event);
}
```

`SessionStore` appends every event as one JSONL line, immediately — there
is no save step and no open handle, so the file is crash-safe by
construction. Because it writes to `~/.spectro/sessions/`, the run appears
in the cockpit's session list next to every CLI and server run.

## Build and run (offline)

```bash
gradle build
gradle run
```

No key, no network: the model is a scripted provider (in this directory)
whose first turn calls the real `write_file` tool. The agent loop executes
that tool for real, so the recorded session has genuine structure — a tool
call, the permission decision, the tool result, usage, and the closing
answer.

The run prints the session id and file path at the end.

## See it in the cockpit

Start the web cockpit — the server jar from the GitHub release, or
`spectro web` from a source checkout:

```bash
java -XX:MaxRAMPercentage=33 -jar spectro-server-0.4.1.jar   # cockpit on http://localhost:8080
```

Every launcher we ship passes that flag; a bare `java -jar` is the one path no
script of ours assembles, so it is the one place you pass it yourself. It gives
the server a third of the machine instead of the JVM's default quarter, and
stays a share, so the same line suits a workstation and a laptop. The server
logs the ceiling it ended up with at boot.

The recorded session is in the sidebar. Open it: the chat shows the
scripted answer, the trace shows the `write_file` call with its input and
result, and the file it wrote is real.

## Notes

- The embedded default permission policy is allow (there is no human at a
  terminal to ask); every request and decision still lands in the stream,
  and therefore in the recording.
- One `RunEvent` per JSONL line is the whole storage contract. The format
  is additive-only, so files recorded today stay loadable.
