// The sessions this page holds a socket to (cards 458 and 459).
//
// The server runs one agent loop per websocket, and closing a socket aborts its
// run (SessionConnection.onClose). So a session that keeps running while the
// reader looks elsewhere is a socket that stays open, and the page keeps one
// record per socket: its folded state, its raw events, its waiting line, its
// steering, its stop flag and its connection status. One record is in view;
// App reads `live` and everything beside it from that one.
//
// The send path lived in App (card 78's queue, card 380's steering). It moved
// here unchanged in behaviour, because with several records it has to run per
// record and App can only hold one `useState` of each. No React in this file:
// the tests drive a fake transport.

import type { ClientMessage, RunEvent } from "../events";
import type { PendingAttachment } from "../components/AttachmentPreview";
import { connect as realConnect } from "../transport/ws";
import type { Connection, ConnectionStatus, ConnectOptions } from "../transport/ws";
import { initialState, noteSent, type UiState } from "./reducer";
import { foldLiveBatch, recordLiveOutgoing } from "./modeWork";
import { commandFrame, type ChatCommandName } from "./chatCommands";
import { asTypedCommand } from "./typedCommand";
import { enqueue, removeQueued, type QueuedMessage } from "./sendQueue";
import { initialSteering, noteFrame, routeSubmit, type SteeringState } from "./steering";
import { readSessionBusy } from "./liveSessions";
import { sessionIdOf } from "../transport/ws";
import type { ViewMode } from "./viewMode";
import type { HeldRow } from "./sessionRows";

export interface SlotConn {
  status: ConnectionStatus;
  /** Epoch ms of the next automatic retry, when status is "closed". */
  retryAt: number | null;
}

/** One socket and everything the page knows about the session on it. */
export interface SessionSlot {
  readonly key: string;
  /** The server's id for the session: the resume id, or what workspace_info named. */
  readonly sessionId: string | null;
  /** The stored session this socket continues, or null for a fresh one. */
  readonly resumeId: string | null;
  readonly state: UiState;
  /** Raw, for the graph, the lab and the mode switch. */
  readonly events: RunEvent[];
  /** Card 78: messages waiting for the run to end. */
  readonly queue: QueuedMessage[];
  /** Card 380: the direct path into a running turn. */
  readonly steering: SteeringState;
  /** Card 78: from an accepted stop until the root run_end. */
  readonly stopRequested: boolean;
  readonly conn: SlotConn;
  /** Epoch ms the page created this record. Orders rows with no file yet. */
  readonly createdAt: number;
  /** True once a user_message left on this socket. A record without one is blank. */
  readonly used: boolean;
  /** Card 459: a run is up and the model has said nothing in it yet. */
  readonly modelSilent: boolean;
  /** Card 498: opened by a wake and not continued yet. Out of the rail, out
   *  of view, until the first message adopts it (continueWoken). */
  readonly woken: boolean;
  /** Live check D6 (card 557): the text of the user_message that left and whose
   *  run has not started, or null. The server can ask the backend for its
   *  window for seconds before run_start; the chat shows the message and
   *  Stop meanwhile. */
  readonly starting: string | null;
}

/** Where a batch came from, for the side effects App routes. */
export interface BatchInfo {
  /** The record is the one on screen. */
  inView: boolean;
  /** The record's socket carries the server-wide frames (fleet) for the page. */
  carrier: boolean;
}

export interface SessionSetDeps {
  connect?: (options: ConnectOptions) => Connection;
  mode: () => ViewMode;
  traceWanted: () => boolean;
  /** Every batch, after it is folded into its record. */
  onBatch?: (key: string, batch: RunEvent[], info: BatchInfo) => void;
  /** A continuation or a wake the server refused because another socket holds
   *  the id. `woken` says it was a wake (card 520): the replay stays as it is. */
  onBusy?: (sessionId: string, woken: boolean) => void;
  /** The record carrying the server-wide frames changed after the first one went away. */
  onCarrierChange?: () => void;
  /** Card 504, review round 2: every client frame that reached a record's
   *  socket, whichever path sent it (App's wrapper, a command, the drain of
   *  a continued session). App's leveling beacons ride here. */
  onSent?: (key: string, msg: ClientMessage) => void;
  now?: () => number;
}

/** What a new record starts from. */
export interface SlotInit {
  resumeId?: string | null;
  state?: UiState;
  events?: RunEvent[];
  /** Sent as soon as the socket is open. */
  firstMessage?: { text: string; attachments?: PendingAttachment[] };
  /** Card 471: a command a continued session sends first, once its socket is open. */
  firstCommand?: ChatCommandName;
  /** Card 504: the frames (set_loop, set_goal, the gear's) a continued session
   *  sends first, in order, once its socket is open. Review round 2 made it a
   *  list: two gear changes before the resume fetched are two frames. */
  firstFrames?: ClientMessage[];
  /** Close the record in view and put this one in its place. */
  replace?: boolean;
  /** Card 498: wake this stored session. The record opens out of view on a
   *  plain socket that sends wake_session once it is open. */
  wake?: string;
}

/** Card 498: what the first message hands the record its wake opened. */
export interface WokenContinuation {
  /** The history folded the way a resume folds it. */
  state: UiState;
  /** The session's stored events. */
  events: RunEvent[];
  firstMessage?: { text: string; attachments?: PendingAttachment[] };
  firstCommand?: ChatCommandName;
  /** Card 504: the frames the composer sent while the session was stored. */
  firstFrames?: ClientMessage[];
}

interface Internal {
  slot: SessionSlot;
  connection: Connection | null;
  /** From an accepted user_message until its run starts or an error arrives. */
  awaitingRunStart: boolean;
  /** Card 471: the command waiting for this record's socket to open, sent once. */
  pendingCommand: ChatCommandName | null;
  /** Card 504: the frames waiting for this record's socket to open, each sent once. */
  pendingFrames: ClientMessage[];
  /** Card 498: the session a wake_session names, sent once the socket is open. */
  pendingWake: string | null;
}

const eventType = (event: RunEvent): string | undefined => (event as { type?: string }).type;

export class SessionSet {
  private readonly deps: SessionSetDeps;
  private readonly records = new Map<string, Internal>();
  private viewed: string | null = null;
  private carrierKey: string | null = null;
  private counter = 0;
  /** False until activate(): a server render (App's guard tests) opens no socket. */
  private active = false;
  private readonly listeners = new Set<() => void>();
  private list: readonly SessionSlot[] = [];
  private held: readonly HeldRow[] = [];

  constructor(deps: SessionSetDeps) {
    this.deps = deps;
  }

  // ---- reading ----

  /** Bound, so it can be handed to useSyncExternalStore as it is. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The record in view. Throws before start(). Bound, like subscribe. */
  readonly view = (): SessionSlot => {
    const key = this.viewed;
    const record = key === null ? undefined : this.records.get(key);
    if (record === undefined) throw new Error("SessionSet: nothing in view before start()");
    return record.slot;
  };

  /** The held sessions as the rail draws them; the same array until one of them changes. */
  readonly heldRows = (): readonly HeldRow[] => this.held;

  viewKey(): string {
    return this.view().key;
  }

  /** Every record, oldest first. The same array until something changes.
   *  Bound, so it can be handed to useSyncExternalStore as it is. */
  readonly slots = (): readonly SessionSlot[] => this.list;

  get(key: string): SessionSlot | undefined {
    return this.records.get(key)?.slot;
  }

  /** Any record of this session, a wake included. */
  findBySession(sessionId: string): SessionSlot | undefined {
    for (const record of this.records.values()) {
      if (record.slot.sessionId === sessionId) return record.slot;
    }
    return undefined;
  }

  /**
   * The chat this page holds for the session, never a wake (card 520). A woken
   * record has no history and stays out of view, so a click on its row or its
   * deep link shows the replay instead of selecting it.
   */
  findHeld(sessionId: string): SessionSlot | undefined {
    for (const record of this.records.values()) {
      if (record.slot.sessionId === sessionId && !record.slot.woken) return record.slot;
    }
    return undefined;
  }

  // ---- lifecycle ----

  /** Opens the first record, a fresh session, if there is none. */
  start(): void {
    if (this.records.size > 0) return;
    this.open({});
  }

  /**
   * Opens a record on its own socket and puts it in view.
   *
   * @return the new record's key
   */
  open(init: SlotInit): string {
    const previous = init.replace === true ? this.viewed : null;
    this.counter += 1;
    const key = `s${this.counter}`;
    const wake = init.wake ?? null;
    const resumeId = wake !== null ? null : (init.resumeId ?? null);
    let queue: QueuedMessage[] = [];
    if (init.firstMessage !== undefined) {
      queue = enqueue(queue, init.firstMessage.text, init.firstMessage.attachments);
    }
    const record: Internal = {
      slot: {
        key,
        sessionId: wake ?? resumeId,
        resumeId,
        state: init.state ?? initialState,
        events: init.events ?? [],
        queue,
        steering: initialSteering,
        stopRequested: false,
        conn: { status: "connecting", retryAt: null },
        createdAt: (this.deps.now ?? Date.now)(),
        used: resumeId !== null,
        modelSilent: false,
        woken: wake !== null,
        starting: null,
      },
      connection: null,
      awaitingRunStart: false,
      pendingCommand: init.firstCommand ?? null,
      pendingFrames: [...(init.firstFrames ?? [])],
      pendingWake: wake,
    };
    this.records.set(key, record);
    // Card 498: a wake stays out of view; the stored session stays on screen.
    if (wake === null || this.viewed === null) this.viewed = key;
    if (previous !== null) this.dropRecord(previous);
    if (this.active) this.attach(key);
    this.electCarrier();
    this.changed();
    return key;
  }

  /**
   * Opens the sockets. App calls it from its mount effect, so rendering the
   * page on a server (the guard tests) opens none; every record opened after
   * this connects at once. Tests call it right after start().
   */
  activate(): void {
    if (this.active) return;
    this.active = true;
    for (const key of this.records.keys()) this.attach(key);
  }

  private attach(key: string): void {
    const record = this.records.get(key);
    if (record === undefined || record.connection !== null) return;
    const resumeId = record.slot.resumeId;
    const connect = this.deps.connect ?? realConnect;
    record.connection = connect({
      onEvents: (batch) => this.onEvents(key, batch),
      ...(resumeId !== null ? { resume: resumeId } : {}),
      onStatus: (status, retryDelayMs) =>
        this.patch(key, {
          conn: {
            status,
            retryAt:
              status === "closed" && retryDelayMs !== undefined
                ? (this.deps.now ?? Date.now)() + retryDelayMs
                : null,
          },
        }),
    });
  }

  /**
   * A new chat (card 459): a new record beside the others. A fresh record
   * nobody has typed into yet is reused rather than stacked, so pressing New
   * chat twice does not leave an empty socket behind.
   *
   * @return the key of the record now in view
   */
  newChat(): string {
    for (const record of this.records.values()) {
      if (isBlank(record.slot)) {
        this.select(record.slot.key);
        return record.slot.key;
      }
    }
    return this.open({});
  }

  /**
   * Live check 0.15.3 D5 (card 556, criterion 3): the user settings changed,
   * and a blank record's socket still holds the ones it loaded at connect.
   * newChat reuses a blank record, so each one goes: out of view it is closed,
   * in view a fresh record takes its place. The next socket loads the
   * settings as they are now.
   *
   * @param except the record whose own socket took the change, or null
   */
  retireBlanks(except: string | null): void {
    const blanks = [...this.records.values()]
      .map((record) => record.slot)
      .filter((slot) => slot.key !== except && isBlank(slot))
      .map((slot) => slot.key);
    for (const key of blanks) {
      if (key === this.viewed) this.open({ replace: true });
      else this.close(key);
    }
  }

  /**
   * Lets a record go for good, for a delete (card 459, owner call 2): a
   * running session is stopped first and given until its run_end, at most
   * `timeoutMs`, so no run appends to a file that is about to be deleted.
   */
  release(key: string, timeoutMs = 5_000): Promise<void> {
    const record = this.records.get(key);
    if (record === undefined) return Promise.resolve();
    if (!record.slot.state.running) {
      this.close(key);
      return Promise.resolve();
    }
    this.abort(key);
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        unsubscribe();
        clearTimeout(timer);
        this.close(key);
        resolve();
      };
      const unsubscribe = this.subscribe(() => {
        const now = this.records.get(key);
        if (now === undefined || !now.slot.state.running) finish();
      });
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  /**
   * The first message of a stored session whose wake opened a record (card
   * 498): the record takes the history the resume folded, replays on top of
   * it the frames its socket already brought (the order a resume's socket
   * would have delivered them in), queues the message and comes into view.
   * The socket stays; the server already holds the session on it.
   */
  continueWoken(key: string, init: WokenContinuation): void {
    const record = this.records.get(key);
    if (record === undefined || !record.slot.woken) return;
    const arrived = record.slot.events;
    const state =
      arrived.length === 0
        ? init.state
        : foldLiveBatch(init.state, arrived, this.deps.mode(), this.deps.traceWanted());
    let queue = record.slot.queue;
    if (init.firstMessage !== undefined) {
      queue = enqueue(queue, init.firstMessage.text, init.firstMessage.attachments);
    }
    record.pendingCommand = init.firstCommand ?? record.pendingCommand;
    record.pendingFrames = [...record.pendingFrames, ...(init.firstFrames ?? [])];
    record.slot = {
      ...record.slot,
      state,
      events: [...init.events, ...arrived],
      resumeId: record.slot.sessionId,
      used: true,
      woken: false,
      queue,
    };
    this.viewed = key;
    this.electCarrier();
    this.changed();
    this.drain(key);
  }

  /** Puts a record in view. Sockets are not touched. */
  select(key: string): void {
    if (!this.records.has(key) || this.viewed === key) return;
    this.viewed = key;
    this.changed();
  }

  /** Closes a record's socket and forgets it. Something stays in view. */
  close(key: string): void {
    if (!this.records.has(key)) return;
    this.dropRecord(key);
    if (this.viewed === key || this.viewed === null) {
      // Card 520: a wake never comes into view on its own.
      const next = [...this.list].reverse().find((slot) => !slot.woken);
      if (next === undefined) {
        this.open({});
        return;
      }
      this.viewed = next.key;
    }
    this.changed();
  }

  /** Closes every socket, for the page going away. */
  dispose(): void {
    this.active = false;
    for (const record of this.records.values()) record.connection?.close();
    this.records.clear();
    this.viewed = null;
    this.carrierKey = null;
    this.list = [];
  }

  reconnectNow(key: string): void {
    this.records.get(key)?.connection?.reconnectNow();
  }

  // ---- state ----

  /** Rewrites one record's folded state (a mode switch, the trace switch). */
  update(key: string, fn: (state: UiState) => UiState): void {
    const record = this.records.get(key);
    if (record === undefined) return;
    const next = fn(record.slot.state);
    if (next === record.slot.state) return;
    this.patch(key, { state: next });
  }

  /** The same rewrite for every record, each with its own events. */
  updateAll(fn: (slot: SessionSlot) => UiState): void {
    let touched = false;
    for (const record of this.records.values()) {
      const next = fn(record.slot);
      if (next !== record.slot.state) {
        record.slot = { ...record.slot, state: next };
        touched = true;
      }
    }
    if (touched) this.changed();
  }

  // ---- sending ----

  /**
   * The one place a client frame leaves for a record: traced into that record
   * only when it actually hit the wire.
   */
  sendClient(key: string, msg: ClientMessage): boolean {
    const record = this.records.get(key);
    if (record === undefined) return false;
    const sent = record.connection?.send(msg) === true;
    if (sent) {
      this.deps.onSent?.(key, msg);
      // Card 576: noted in every mode; the trace row only where the trace is open.
      const state = noteSent(
        recordLiveOutgoing(record.slot.state, msg, this.deps.mode(), this.deps.traceWanted()),
        msg,
      );
      if (state !== record.slot.state) this.patch(key, { state });
      if (msg.type === "user_message" && !record.slot.used) this.patch(key, { used: true });
    }
    return sent;
  }

  /** A user_message now; the attachments' thumbnails are parked for run_start. */
  sendNow(key: string, text: string, attachments?: PendingAttachment[]): boolean {
    const record = this.records.get(key);
    if (record === undefined) return false;
    const withFiles = attachments !== undefined && attachments.length > 0;
    const sent = this.sendClient(key, {
      type: "user_message",
      text,
      ...(withFiles
        ? { attachments: attachments.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 })) }
        : {}),
    });
    if (sent && withFiles) {
      const parked = attachments.map(({ name, mediaType, dataBase64 }) => ({ name, mediaType, dataBase64 }));
      this.update(key, (s) => ({ ...s, outboxAttachments: parked }));
    }
    if (sent) {
      record.awaitingRunStart = true;
      this.patch(key, { starting: text });
    }
    return sent;
  }

  /**
   * A submit from the composer. The composer never locks: during a run a plain
   * sentence steers the running turn (card 380), everything else waits in the
   * queue and is drained when the session is free (card 78).
   */
  send(key: string, text: string, attachments?: PendingAttachment[]): void {
    const record = this.records.get(key);
    if (record === undefined) return;
    const slot = record.slot;
    const open = slot.conn.status === "open";
    // Card 471: a /compact makes the page run without a run to steer; a
    // sentence typed meanwhile waits and goes out once it has ended.
    const steerable = slot.state.running && !slot.state.compacting;
    if (steerable && !record.awaitingRunStart && open && slot.queue.length === 0) {
      const routed = routeSubmit(slot.steering, text, attachments);
      if (routed.action === "drop") return;
      if (routed.action === "steer" && this.sendClient(key, routed.frame)) {
        this.patch(key, { steering: routed.next });
        return;
      }
      // A frame that never hit the wire falls through to the queue.
    }
    if (slot.state.running || record.awaitingRunStart || !open || slot.queue.length > 0) {
      this.patch(key, { queue: enqueue(record.slot.queue, text, attachments) });
      this.drain(key);
      return;
    }
    this.sendNow(key, text, attachments);
  }

  unqueue(key: string, id: number): void {
    const record = this.records.get(key);
    if (record === undefined) return;
    this.patch(key, { queue: removeQueued(record.slot.queue, id) });
  }

  /**
   * A command from the composer (card 471): its own frame, now, on this
   * record's socket. Never a user_message and never a steering_message, which
   * would hand "/clear" to the model as words, and never the queue: a command
   * answered after the run would act on a history the reader has moved past.
   * During a run it still goes out, and the server answers with the refusal a
   * second prompt gets.
   *
   * @return false when the socket is not open; nothing is kept for later
   */
  command(key: string, name: ChatCommandName): boolean {
    // Card 576: the composer's /compact and /clear, so a typed command.
    return this.sendClient(key, asTypedCommand(commandFrame(name)));
  }

  /** The stop button: "stopping" shows only for a frame that reached a running socket. */
  abort(key: string): void {
    const record = this.records.get(key);
    if (record === undefined) return;
    const sent = this.sendClient(key, { type: "abort" });
    // Live check 0.15.3 D6: a run that has not started yet is stopped too.
    if (sent && (record.slot.state.running || record.awaitingRunStart))
      this.patch(key, { stopRequested: true });
  }

  // ---- internals ----

  private onEvents(key: string, batch: RunEvent[]): void {
    const record = this.records.get(key);
    if (record === undefined) return; // a record closed while its last batch was queued
    const before = record.slot;
    const state = foldLiveBatch(before.state, batch, this.deps.mode(), this.deps.traceWanted());
    let steering = before.steering;
    const giveBack: string[] = [];
    let sessionId = before.sessionId;
    let busy: string | null = null;
    let settles = false;
    let silent = before.modelSilent;
    for (const event of batch) {
      const read = noteFrame(steering, event);
      steering = read.next;
      giveBack.push(...read.requeue);
      const named = sessionIdOf(event);
      if (named !== null) sessionId = named;
      const refused = readSessionBusy(event);
      if (refused !== null) busy = refused;
      const type = eventType(event);
      if (type === "run_start" || type === "run_end" || type === "error") settles = true;
      if (type === "run_start" && (event as { parentId?: unknown }).parentId == null) silent = true;
      if (type === "text_delta" || type === "thinking_delta" || type === "tool_call" || type === "run_end") {
        silent = false;
      }
    }
    if (settles || state.running) record.awaitingRunStart = false;
    const queue = giveBack.reduce((line, text) => enqueue(line, text), before.queue);
    record.slot = {
      ...before,
      state,
      events: [...before.events, ...batch],
      steering,
      queue,
      sessionId,
      stopRequested: state.running || record.awaitingRunStart ? before.stopRequested : false,
      modelSilent: silent && state.running,
      starting: record.awaitingRunStart ? before.starting : null,
    };
    this.changed();
    this.deps.onBatch?.(key, batch, { inView: this.viewed === key, carrier: this.carrierKey === key });
    if (busy !== null) {
      this.deps.onBusy?.(busy, record.slot.woken);
      this.close(key);
      return;
    }
    this.drain(key);
  }

  /** The queue's drain: the moment a record is free and open, its next message goes. */
  private drain(key: string): void {
    const record = this.records.get(key);
    if (record === undefined) return;
    const slot = record.slot;
    if (slot.conn.status === "open" && record.pendingWake !== null) {
      const wake = record.pendingWake;
      record.pendingWake = null;
      this.sendClient(key, { type: "wake_session", sessionId: wake });
      // Card 558, round 3: the woken session's own items for its picker, with
      // or without a pick; the server answers once the wake has set its folder.
      this.sendClient(key, { type: "get_session_items" });
    }
    if (slot.conn.status === "open" && record.pendingCommand !== null) {
      const command = record.pendingCommand;
      record.pendingCommand = null;
      this.command(key, command);
    }
    if (slot.conn.status === "open" && record.pendingFrames.length > 0) {
      const frames = record.pendingFrames;
      record.pendingFrames = [];
      for (const frame of frames) this.sendClient(key, frame);
    }
    if (
      slot.conn.status !== "open" ||
      slot.state.running ||
      record.awaitingRunStart ||
      slot.queue.length === 0
    ) {
      return;
    }
    const next = slot.queue[0];
    if (this.sendNow(key, next.text, next.attachments)) {
      const now = this.records.get(key);
      if (now !== undefined) this.patch(key, { queue: removeQueued(now.slot.queue, next.id) });
    }
  }

  private patch(key: string, fields: Partial<SessionSlot>): void {
    const record = this.records.get(key);
    if (record === undefined) return;
    record.slot = { ...record.slot, ...fields };
    this.changed();
    if (fields.conn !== undefined || fields.queue !== undefined) this.drain(key);
  }

  private dropRecord(key: string): void {
    const record = this.records.get(key);
    if (record === undefined) return;
    this.records.delete(key);
    record.connection?.close();
    if (this.viewed === key) this.viewed = null;
    this.electCarrier();
    this.rebuildList();
  }

  /**
   * The oldest record carries the server-wide frames; it changes only when it
   * goes. A wake never carries them (card 520): it closes as soon as its
   * session leaves the screen, and the fleet would go quiet with it.
   */
  private electCarrier(): void {
    const current = this.carrierKey === null ? undefined : this.records.get(this.carrierKey);
    if (current !== undefined && !current.slot.woken) return;
    const had = this.carrierKey;
    let next: string | null = null;
    for (const [key, record] of this.records) {
      if (!record.slot.woken) {
        next = key;
        break;
      }
    }
    this.carrierKey = next;
    if (had !== null && next !== had && this.active) this.deps.onCarrierChange?.();
  }

  private rebuildList(): void {
    this.list = [...this.records.values()].map((record) => record.slot);
    const rows = heldRowsOf(this.list);
    if (!sameRows(rows, this.held)) this.held = rows;
  }

  private changed(): void {
    this.rebuildList();
    for (const listener of this.listeners) listener();
  }
}

/** A record nobody has typed into, with no session yet: what New chat reuses. */
function isBlank(slot: SessionSlot): boolean {
  return !slot.used && slot.resumeId === null && slot.sessionId === null && slot.queue.length === 0;
}

/** The backend a record's session runs on, as far as its frames said. */
function providerOf(slot: SessionSlot): string | null {
  return slot.state.providerInfo?.provider ?? slot.state.provider ?? null;
}

/**
 * What a held row asks of the reader (card 459).
 *
 * "answer": the session waits on a question or a permission (card 265 and the
 * gate), and the reader may be looking at another session. "model": its run
 * has had no word from the model yet while another session streams on the
 * same backend, which is what a backend serving one request at a time looks
 * like from here (owner call 3). A guess from the outside, so it only speaks
 * when the other stream is there to explain the silence.
 */
function attentionOf(slot: SessionSlot, all: readonly SessionSlot[]): HeldRow["attention"] {
  if (slot.state.pendingAsks.length > 0 || slot.state.pendingPermissions.length > 0) return "answer";
  if (!slot.state.running || !slot.modelSilent) return null;
  const provider = providerOf(slot);
  const busy = all.some(
    (other) =>
      other.key !== slot.key && other.state.running && !other.modelSilent && providerOf(other) === provider,
  );
  return busy ? "model" : null;
}

/** The first prompt of a folded session, or "" before there is one. */
function firstPromptOf(state: UiState): string {
  const first = state.turns.find((turn) => turn.kind === "user");
  return first !== undefined && first.kind === "user" ? first.text : "";
}

/** Every record that has a session id, as a rail row. */
export function heldRowsOf(slots: readonly SessionSlot[]): HeldRow[] {
  const rows: HeldRow[] = [];
  for (const slot of slots) {
    if (slot.sessionId === null || slot.woken) continue;
    rows.push({
      id: slot.sessionId,
      firstPrompt: firstPromptOf(slot.state),
      startedAt: slot.createdAt,
      running: slot.state.running,
      attention: attentionOf(slot, slots),
    });
  }
  return rows;
}

function sameRows(a: readonly HeldRow[], b: readonly HeldRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.firstPrompt !== y.firstPrompt ||
      x.startedAt !== y.startedAt ||
      x.running !== y.running ||
      x.attention !== y.attention
    ) {
      return false;
    }
  }
  return true;
}
