// A desktop shell with nothing in it but the browser pane.
//
// main.ts spawns and supervises a JVM; this entry does not — it attaches the
// REAL pane and the REAL control channel to a server that is already running,
// which is what lets an integration test on the Java side drive the actual
// tools against an actual Chromium instead of a fake.
//
// Same modules the app ships (dist/browserPane.js, dist/browserControl.js), so
// a change to either changes what the test proves.
//
// Run: SPECTRO_SERVER_PORT=8123 electron test/livePane.js

const { app, BaseWindow } = require("electron");
const path = require("node:path");
const { attachPaneTo } = require(path.join(__dirname, "..", "dist", "browserPane.js"));
const { connectBrowserControl } = require(path.join(__dirname, "..", "dist", "browserControl.js"));

const PORT = Number(process.env.SPECTRO_SERVER_PORT || "0");

app.whenReady().then(() => {
  if (!PORT) {
    console.error("SPECTRO_SERVER_PORT is required");
    app.exit(2);
    return;
  }
  const win = new BaseWindow({ width: 1200, height: 820, title: "spectroscope browser (live)" });
  // No app page here, so there is no segment to switch to: the pane takes the
  // whole window and the segment request is a no-op.
  attachPaneTo(
    () => win,
    () => {},
  );
  connectBrowserControl(PORT);
  console.log("live pane attached to port " + PORT);
});
