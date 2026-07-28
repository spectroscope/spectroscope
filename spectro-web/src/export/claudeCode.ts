// Writing a spectroscope stream OUT as a Claude Code transcript.
//
// This is the inverse of src/import/claudeCode.ts, and the pair is tested by
// round trip: write, read back through that importer, assert exactly the losses
// the dialog printed. That test is the only thing that keeps the promise honest
// once either side moves, which is why the writer lives next to the option
// model rather than beside the reader.
//
// The shape it targets is the transcript's own: user and assistant records
// whose `message.content` is a list of blocks. Two structural rules of that
// format drive everything below — a tool RESULT rides in a user record (the
// tool reporting back), and a subagent is a `Task` tool_use whose id doubles as
// the child's identity, with the child's own records marked `isSidechain`.
//
// WHAT CANNOT BE WRITTEN: the permission gate. A transcript has no record of a
// call being asked about, allowed or denied, so those events have nowhere to
// go. They are counted and named in the dialog (options.ts), not dropped
// quietly here.

import type { RunEvent } from "../events";

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface Record_ {
  type: "user" | "assistant";
  uuid: string;
  parentUuid: string | null;
  isSidechain?: boolean;
  timestamp: string;
  message: {
    role: "user" | "assistant";
    content: string | Block[];
    model?: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
}

const iso = (ts: number): string => new Date(ts).toISOString();

/**
 * The stream as a Claude Code transcript.
 *
 * @param events the stream to write, in wire order
 * @return one JSON record per line, terminated; "" for an empty stream
 */
export function toClaudeCodeJsonl(events: readonly RunEvent[]): string {
  if (events.length === 0) return "";

  const records: Record_[] = [];
  let seq = 0;
  const uuid = (): string => `spectro-${++seq}`;

  // Agents that were spawned as a Task, so their records can be marked as the
  // sidechain of that Task and closed against it at the end.
  const spawned = new Map<string, number>();
  let model: string | undefined;
  let opened = false;
  let last = events[0].ts;

  /** The assistant record currently being filled, per agent. Blocks accumulate
   *  until something has to break the record: a tool result (which is a USER
   *  record), a change of agent, or the end of the run.
   *
   *  Held in a box rather than a bare `let` because the writers below are
   *  closures: the compiler cannot see an assignment made inside one, and would
   *  narrow the variable to its initial null for the whole loop. */
  const open: { at: { agentId: string; blocks: Block[]; ts: number } | null } = { at: null };

  const flush = (): void => {
    const pending = open.at;
    open.at = null;
    if (pending === null || pending.blocks.length === 0) return;
    const child = spawned.has(pending.agentId);
    records.push({
      type: "assistant",
      uuid: uuid(),
      // A sidechain record finds its Task by walking parentUuid; pointing
      // straight at the Task id is the shortest chain that resolves.
      parentUuid: child ? pending.agentId : null,
      ...(child ? { isSidechain: true } : {}),
      timestamp: iso(pending.ts),
      message: {
        role: "assistant",
        content: pending.blocks,
        ...(model !== undefined ? { model } : {}),
      },
    });
  };

  const blocksFor = (agentId: string, ts: number): Block[] => {
    if (open.at !== null && open.at.agentId !== agentId) flush();
    if (open.at === null) open.at = { agentId, blocks: [], ts };
    return open.at.blocks;
  };

  /** A user record: the first one opens the run, later ones carry tool results. */
  const userRecord = (content: string | Block[], ts: number): void => {
    flush();
    records.push({
      type: "user",
      uuid: uuid(),
      parentUuid: null,
      timestamp: iso(ts),
      message: { role: "user", content },
    });
  };

  for (const event of events) {
    last = event.ts;
    switch (event.type) {
      case "run_start": {
        // Only the ROOT run opens the transcript; a child's run_start is
        // implied by its Task block and its sidechain records.
        if (event.parentId !== undefined && event.parentId !== null) break;
        if (event.model !== undefined && event.model !== "") model = event.model;
        if (!opened) {
          opened = true;
          userRecord(event.prompt, event.ts);
        } else {
          // A re-opened run is another user turn, which is what it renders as.
          userRecord([{ type: "text", text: event.prompt }], event.ts);
        }
        break;
      }

      case "turn_start":
        // One assistant message is one turn on that side too.
        if (open.at !== null && open.at.agentId === event.agentId) flush();
        break;

      case "thinking_delta":
        if (event.text !== "")
          blocksFor(event.agentId, event.ts).push({ type: "thinking", thinking: event.text });
        break;

      case "text_delta":
        if (event.text !== "") blocksFor(event.agentId, event.ts).push({ type: "text", text: event.text });
        break;

      case "tool_call":
        blocksFor(event.agentId, event.ts).push({
          type: "tool_use",
          id: event.callId,
          name: event.name,
          input: event.input,
        });
        break;

      case "agent_spawn": {
        // The child's identity IS the Task's tool_use id on that side, so the
        // subagent survives the round trip with its task text and its lane.
        spawned.set(event.agentId, event.ts);
        blocksFor(event.parentId, event.ts).push({
          type: "tool_use",
          id: event.agentId,
          name: "Task",
          input: { description: event.task, subagent_type: "task" },
        });
        break;
      }

      case "tool_result":
        userRecord(
          [
            {
              type: "tool_result",
              tool_use_id: event.callId,
              content: event.output,
              is_error: event.isError,
            },
          ],
          event.ts,
        );
        break;

      case "usage": {
        // Usage rides on an assistant record; attach it to the most recent one
        // rather than inventing an empty message to hang it from.
        flush();
        for (let i = records.length - 1; i >= 0; i--) {
          if (records[i].type === "assistant" && records[i].isSidechain !== true) {
            records[i].message.usage = {
              input_tokens: event.inputTokens,
              output_tokens: event.outputTokens,
            };
            break;
          }
        }
        break;
      }

      default:
        // permission_request/decision, compaction, plan, context_info and the
        // rest have no counterpart. options.ts counts and names the ones a
        // reader would miss; the others are protocol, not record.
        break;
    }
  }
  flush();

  // Close every child against its Task, so the re-read stream ends its
  // subagents instead of leaving them open forever.
  const closers: Block[] = [...spawned.keys()].map((agentId) => ({
    type: "tool_result",
    tool_use_id: agentId,
    content: "",
    is_error: false,
  }));
  if (closers.length > 0) userRecord(closers, last);

  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}
