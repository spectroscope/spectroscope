// Card 380, criterion 13: a server that does not know the steering frame.
//
// The frames are counted where they leave: at a socket double under the real
// transport (`connect` from transport/ws.ts, driven through its TransportHost
// the way ws.test.ts drives it). The error rows are counted in the real
// reducer. The decisions come from the real modules: routeSubmit and noteFrame
// (state/steering.ts), enqueue and removeQueued (state/sendQueue.ts).
//
// What is modelled here and not imported: the page's glue between those
// modules. `page()` below follows App.tsx: the send path (`send`, its steering
// branch and the queue guard), the steering loop in `onEvents`, the two effects
// that release the drain latch (a run started, an error row appeared) and the
// queue drain. A change to that glue in App.tsx does not reach this test.

import { describe, expect, it } from "vitest";
import { connect, type Connection, type TransportHost, type TransportSocket } from "../transport/ws";
import type { ClientMessage, RunEvent } from "../events";
import { initialState, reduceAll, type UiState } from "./reducer";
import { enqueue, removeQueued, type QueuedMessage } from "./sendQueue";
import { initialSteering, noteFrame, routeSubmit, type SteeringState } from "./steering";

const REFUSAL = { type: "error", message: "Unknown message type.", ts: 1 };

interface Crossed {
  dir: "out" | "in";
  type: string;
  text?: string;
}

interface FakeServer {
  connection: Connection;
  /** Every frame in both directions, in the order it crossed the socket. */
  timeline: Crossed[];
  /** Deliver one frame from the server. */
  deliver(frame: { type: string }): void;
  /** Run every armed animation frame until none is left, which is when the
   *  transport folds its buffer into the page. */
  paint(): void;
}

/**
 * A server behind a socket double. An older one answers a steering frame the
 * way SpectroSocketHandler's default arm does, with "Unknown message type.";
 * a current one takes it and answers nothing yet. Both answer a user_message
 * by starting a run. Run ends are the test's to deliver.
 */
function fakeServer(onEvents: (batch: RunEvent[]) => void, knowsSteering: boolean): FakeServer {
  const frames = new Map<number, () => void>();
  let next = 1;
  let socket: TransportSocket | null = null;
  const timeline: Crossed[] = [];
  let runs = 0;

  const deliver = (frame: { type: string; text?: string }): void => {
    timeline.push({ dir: "in", type: frame.type });
    socket?.onmessage?.(JSON.stringify(frame));
  };

  const host: TransportHost = {
    requestFrame(run) {
      const handle = next++;
      frames.set(handle, run);
      return handle;
    },
    cancelFrame(handle) {
      frames.delete(handle);
    },
    // No timer ever fires: the liveness probe stays unsent, so the transport
    // never reads a refusal as the answer to its own question.
    setTimer: () => next++,
    clearTimer: () => undefined,
    now: () => 0,
    openSocket() {
      const opened: TransportSocket = {
        isOpen: () => true,
        send(text) {
          const frame = JSON.parse(text) as { type: string; text?: string };
          timeline.push({ dir: "out", type: frame.type, text: frame.text });
          if (frame.type === "steering_message" && !knowsSteering) {
            deliver(REFUSAL);
          }
          if (frame.type === "user_message") {
            runs += 1;
            deliver({ type: "run_start", runId: `r${runs}`, agentId: "main", prompt: frame.text, ts: 2 } as {
              type: string;
            });
          }
        },
        close() {},
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      socket = opened;
      return opened;
    },
  };

  const connection = connect({ url: "ws://x/ws", host, onEvents });
  socket!.onopen?.();

  return {
    connection,
    timeline,
    deliver,
    paint() {
      while (frames.size > 0) {
        const due = [...frames.values()];
        frames.clear();
        for (const run of due) run();
      }
    },
  };
}

interface Page {
  server: FakeServer;
  submit(text: string): void;
  ui(): UiState;
  queue(): QueuedMessage[];
  steering(): SteeringState;
}

/** The page's glue, following App.tsx (see the header). */
function page(knowsSteering = false): Page {
  let ui = initialState;
  let steering: SteeringState = initialSteering;
  let queue: QueuedMessage[] = [];
  let awaitingRunStart = false;
  let errorRows = 0;
  let server: FakeServer | null = null;

  // App's sendClient: the transport's send, true only when the frame left.
  const sendClient = (msg: ClientMessage): boolean => server!.connection.send(msg);

  const sendNow = (text: string): boolean => {
    const sent = sendClient({ type: "user_message", text });
    if (sent) awaitingRunStart = true;
    return sent;
  };

  // The effects App runs after a render: a started run releases the drain
  // latch, so does a new error row, and the drain sends the head of the queue
  // once the session is free.
  const afterRender = (): void => {
    if (ui.running) awaitingRunStart = false;
    const errors = ui.turns.filter((t) => t.kind === "error").length;
    if (errors !== errorRows) {
      errorRows = errors;
      awaitingRunStart = false;
    }
    if (!ui.running && !awaitingRunStart && queue.length > 0) {
      const head = queue[0];
      if (sendNow(head.text)) queue = removeQueued(queue, head.id);
    }
  };

  const onEvents = (batch: RunEvent[]): void => {
    ui = reduceAll(ui, batch);
    let steer = steering;
    const giveBack: string[] = [];
    for (const event of batch as unknown[]) {
      const read = noteFrame(steer, event);
      steer = read.next;
      giveBack.push(...read.requeue);
    }
    steering = steer;
    queue = giveBack.reduce((line, text) => enqueue(line, text), queue);
    afterRender();
  };

  server = fakeServer(onEvents, knowsSteering);

  return {
    server,
    ui: () => ui,
    queue: () => queue,
    steering: () => steering,
    submit(text) {
      if (ui.running && !awaitingRunStart && queue.length === 0) {
        const routed = routeSubmit(steering, text);
        if (routed.action === "drop") return;
        if (routed.action === "steer" && sendClient(routed.frame)) {
          steering = routed.next;
          return;
        }
      }
      if (ui.running || awaitingRunStart || queue.length > 0) {
        queue = enqueue(queue, text);
        return;
      }
      sendNow(text);
    },
  };
}

const sent = (p: Page, type: string): string[] =>
  p.server.timeline.filter((c) => c.dir === "out" && c.type === type).map((c) => c.text ?? "");

const errorRows = (p: Page): number => p.ui().turns.filter((t) => t.kind === "error").length;

/** For each user_message that went out, how many run_end frames had arrived
 *  before it. */
function runEndsBeforeEachUserMessage(p: Page): number[] {
  const out: number[] = [];
  let ends = 0;
  for (const crossed of p.server.timeline) {
    if (crossed.dir === "in" && crossed.type === "run_end") ends += 1;
    if (crossed.dir === "out" && crossed.type === "user_message") out.push(ends);
  }
  return out;
}

/** Ends the run that is up, and lets the page fold the frame and react. */
function endRun(p: Page, runId: string): void {
  p.server.deliver({ type: "run_end", runId, stopReason: "end_turn", ts: 3 } as { type: string });
  p.server.paint();
}

/** A run the page did not start (another prompt, sent earlier) is up. */
function aRunIsUp(knowsSteering = false): Page {
  const p = page(knowsSteering);
  p.server.deliver({ type: "run_start", runId: "r0", agentId: "main", prompt: "earlier", ts: 1 } as {
    type: string;
  });
  p.server.paint();
  expect(p.ui().running).toBe(true);
  return p;
}

describe("an older server refuses the steering frame (card 380, criterion 13)", () => {
  it("one steering frame, one error row, and every sentence goes out as a user_message after a run_end", () => {
    const p = aRunIsUp();

    p.submit("A");
    p.server.paint();
    p.submit("B");
    p.submit("C");
    p.server.paint();

    expect(sent(p, "steering_message")).toEqual(["A"]);
    expect(errorRows(p)).toBe(1);
    expect(p.queue().map((m) => m.text)).toEqual(["A", "B", "C"]);
    expect(sent(p, "user_message")).toEqual([]);

    // The runs the queue starts, one after the other.
    endRun(p, "r0");
    endRun(p, "r1");
    endRun(p, "r2");
    endRun(p, "r3");

    expect(sent(p, "user_message")).toEqual(["A", "B", "C"]);
    expect(runEndsBeforeEachUserMessage(p)).toEqual([1, 2, 3]);
    expect(sent(p, "steering_message")).toEqual(["A"]);
    expect(errorRows(p)).toBe(1);
  });

  it("sends no second steering frame on that socket when the next run is up and nothing waits", () => {
    // The case the test above cannot see: there the refused sentence is back
    // in the queue, and a non-empty queue keeps every later submit off the
    // steering path whatever the refusal flag says. Here the queue has drained
    // and a run is up, so only the flag stands between B and a second frame.
    const p = aRunIsUp();

    p.submit("A");
    p.server.paint();
    endRun(p, "r0");
    expect(sent(p, "user_message")).toEqual(["A"]);
    expect(p.ui().running).toBe(true);
    expect(p.queue()).toEqual([]);

    p.submit("B");
    p.server.paint();

    expect(sent(p, "steering_message")).toEqual(["A"]);
    expect(p.queue().map((m) => m.text)).toEqual(["B"]);

    endRun(p, "r1");
    endRun(p, "r2");
    expect(sent(p, "user_message")).toEqual(["A", "B"]);
    expect(errorRows(p)).toBe(1);
  });

  it("a server that knows the frame gets all three sentences as steering frames", () => {
    // The positive twin, on the same page glue: three steering frames is the
    // normal path. The two tests above assert one, and they would also be
    // green on a page that stopped steering after its first frame for any
    // reason; this one would not.
    const p = aRunIsUp(true);

    p.submit("A");
    p.server.paint();
    p.submit("B");
    p.submit("C");
    p.server.paint();

    expect(sent(p, "steering_message")).toEqual(["A", "B", "C"]);
    expect(errorRows(p)).toBe(0);
    expect(p.queue()).toEqual([]);

    // The run reads all three at its next safe point and writes one line.
    p.server.deliver({
      type: "steering_message",
      agentId: "main",
      text: "A\nB\nC",
      taken: true,
      turn: 2,
      ts: 3,
    } as { type: string });
    p.server.paint();
    endRun(p, "r0");

    expect(p.steering().pending).toEqual([]);
    expect(sent(p, "user_message")).toEqual([]);
  });
});
