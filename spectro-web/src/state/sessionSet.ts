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
import { initialState, type UiState } from "./reducer";
import { foldLiveBatch, recordLiveOutgoing } from "./modeWork";
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
  /** A continuation the server refused because another socket holds the id. */
  onBusy?: (sessionId: string) => void;
  /** The record carrying the server-wide frames changed after the first one went away. */
  onCarrierChange?: () => void;
  now?: () => number;
}

/** What a new record starts from. */
export interface SlotInit {
  resumeId?: string | null;
  state?: UiState;
  events?: RunEvent[];
  /** Sent as soon as the socket is open. */
  firstMessage?: { text: string; attachments?: PendingAttachment[] };
  /** Close the record in view and put this one in its place. */
  replace?: boolean;
}

interface Internal {
  slot: SessionSlot;
  connection: Connection | null;
  /** From an accepted user_message until its run starts or an error arrives. */
  awaitingRunStart: boolean;
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

  /** Every record, oldest first. The same array until something changes. */
  slots(): readonly SessionSlot[] {
    return this.list;
  }

  get(key: string): SessionSlot | undefined {
    return this.records.get(key)?.slot;
  }

  findBySession(sessionId: string): SessionSlot | undefined {
    for (const record of this.records.values()) {
      if (record.slot.sessionId === sessionId) return record.slot;
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
    const resumeId = init.resumeId ?? null;
    let queue: QueuedMessage[] = [];
    if (init.firstMessage !== undefined) {
      queue = enqueue(queue, init.firstMessage.text, init.firstMessage.attachments);
    }
    const record: Internal = {
      slot: {
        key,
        sessionId: resumeId,
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
      },
      connection: null,
      awaitingRunStart: false,
    };
    this.records.set(key, record);
    this.viewed = key;
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
      const slot = record.slot;
      if (!slot.used && slot.resumeId === null && slot.sessionId === null && slot.queue.length === 0) {
        this.select(slot.key);
        return slot.key;
      }
    }
    return this.open({});
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
      const next = this.list.length > 0 ? this.list[this.list.length - 1] : undefined;
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
      const state = recordLiveOutgoing(record.slot.state, msg, this.deps.mode(), this.deps.traceWanted());
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
    if (sent) record.awaitingRunStart = true;
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
    if (slot.state.running && !record.awaitingRunStart && open && slot.queue.length === 0) {
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

  /** The stop button: "stopping" shows only for a frame that reached a running socket. */
  abort(key: string): void {
    const record = this.records.get(key);
    if (record === undefined) return;
    const sent = this.sendClient(key, { type: "abort" });
    if (sent && record.slot.state.running) this.patch(key, { stopRequested: true });
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
      stopRequested: state.running ? before.stopRequested : false,
      modelSilent: silent && state.running,
    };
    this.changed();
    this.deps.onBatch?.(key, batch, { inView: this.viewed === key, carrier: this.carrierKey === key });
    if (busy !== null) {
      this.deps.onBusy?.(busy);
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

  /** The oldest record carries the server-wide frames; it changes only when it goes. */
  private electCarrier(): void {
    if (this.carrierKey !== null && this.records.has(this.carrierKey)) return;
    const had = this.carrierKey;
    const first = this.records.keys().next();
    this.carrierKey = first.done === true ? null : first.value;
    if (had !== null && this.carrierKey !== null && this.active) this.deps.onCarrierChange?.();
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
    if (slot.sessionId === null) continue;
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
