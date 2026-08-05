// One real agent run against a live server, used to give the tutorial plates a
// receipt that points at something that actually happened.
//
// The panel plate is the reason this exists. A criterion marked by hand says
// "manual" on its receipt forever, and a screenshot of the progress panel whose
// every line reads "manual" would be a picture of the feature not working. So
// the run is real: a local model through ollama writes a file, the gate is
// answered, and the marks the engine makes carry a session id and an event
// index that resolve to a frame in that session.
//
// It talks the socket the app talks, from inside a page on the app's own
// origin, so no extra dependency is needed and the frames are the same ones the
// interface would have produced.
//
// Usage:
//   BASE_URL=http://localhost:8150 node leveling_real_run.mjs

import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:8150";
const PROMPT =
  process.env.PROMPT ||
  "Write a file called hello.txt containing the single word hi, then say you are done.";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded" });

const result = await page.evaluate(
  async ([prompt]) => {
    const socket = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws");
    const events = [];
    let sessionId = null;

    const done = new Promise((resolve, reject) => {
      const giveUp = setTimeout(() => reject(new Error("no run_end within 240s")), 240_000);
      socket.onerror = () => {
        clearTimeout(giveUp);
        reject(new Error("socket error"));
      };
      socket.onmessage = (message) => {
        let frame;
        try {
          frame = JSON.parse(message.data);
        } catch {
          return;
        }
        events.push(frame);
        const type = frame.type ?? frame.event ?? "";
        if (frame.sessionId && !sessionId) sessionId = frame.sessionId;
        if (frame.payload?.sessionId && !sessionId) sessionId = frame.payload.sessionId;

        // Answer the gate the write parks. Doing it here rather than pre-setting
        // auto keeps a real permission decision in the session's event stream.
        if (type === "permission_request" || type === "permission_requested") {
          const callId = frame.payload?.callId ?? frame.callId;
          if (callId) {
            socket.send(JSON.stringify({ type: "permission_response", callId, allowed: true, remember: true }));
          }
        }
        if (type === "run_end") {
          clearTimeout(giveUp);
          setTimeout(resolve, 400);
        }
      };
    });

    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      setTimeout(() => reject(new Error("socket did not open")), 15_000);
    });
    socket.send(JSON.stringify({ type: "user_message", text: prompt }));
    await done;

    const types = events.map((e) => e.type ?? e.event ?? "?");
    return { sessionId, count: events.length, types };
  },
  [PROMPT],
);

console.log("session:", result.sessionId);
console.log("frames:", result.count);
console.log("types:", [...new Set(result.types)].join(", "));

const state = await page.evaluate(() => fetch("/api/leveling").then((r) => r.json()));
console.log("level:", state.level, state.levelId);
console.log("marks:", JSON.stringify(state.marks, null, 2));

await browser.close();
