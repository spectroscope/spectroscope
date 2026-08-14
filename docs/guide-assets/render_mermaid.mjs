// render_mermaid.mjs — pre-renders mermaid-src/*.mmd to mermaid/*.svg
// (dark theme on the spectroscope brand tokens; the guide inlines the SVGs so the PDF
// needs no JavaScript). Needs `playwright` and `mermaid` resolvable FROM THIS FILE —
// this directory, or any node_modules above it. A symlink is enough:
//
//   mkdir -p node_modules && ln -s <somewhere>/node_modules/mermaid node_modules/mermaid
//   PW_CHANNEL=bundled node render_mermaid.mjs
//
// Do NOT reach for NODE_PATH to point at mermaid, however natural that looks. Measured
// 2026-08-14: with NODE_PATH set to a foreign node_modules, `import("playwright")` never
// returns — no error, no timeout, no browser process, and nothing on stdout because node
// buffers it, so it reads as "rendering is slow" for as long as you are willing to wait.
// Without NODE_PATH the same script reaches its first rendered diagram in 0.8 s.
//
//   OUT_DIR=<...>/guide-assets node render_mermaid.mjs

import { chromium } from "playwright";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const HERE = process.env.OUT_DIR || dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "mermaid-src");
const OUT = join(HERE, "mermaid");
mkdirSync(OUT, { recursive: true });

const mermaidJs = readFileSync(require.resolve("mermaid/dist/mermaid.min.js"), "utf8");

const THEME = {
  theme: "base",
  themeVariables: {
    background: "transparent",
    fontFamily: "Helvetica, Arial, sans-serif",
    fontSize: "14px",
    primaryColor: "#201913",
    primaryTextColor: "#EDE7DC",
    primaryBorderColor: "#5C5142",
    secondaryColor: "#1C1610",
    tertiaryColor: "#292019",
    lineColor: "#A2988A",
    textColor: "#EDE7DC",
    nodeTextColor: "#EDE7DC",
    mainBkg: "#201913",
    clusterBkg: "#1C1610",
    clusterBorder: "#33291F",
    titleColor: "#FFEF7A",
    edgeLabelBackground: "#1C1610",
    actorBkg: "#201913",
    actorBorder: "#5C5142",
    actorTextColor: "#EDE7DC",
    actorLineColor: "#6E6D63",
    signalColor: "#EDE7DC",
    signalTextColor: "#EDE7DC",
    labelBoxBkgColor: "#1C1610",
    labelBoxBorderColor: "#FFEF7A",
    labelTextColor: "#FFEF7A",
    loopTextColor: "#FFEF7A",
    noteBkgColor: "#1c1c17",
    noteBorderColor: "#FFEF7A",
    noteTextColor: "#EDE7DC",
    activationBkgColor: "#292019",
    activationBorderColor: "#CE9440",
    sequenceNumberColor: "#12120F",
  },
  themeCSS: `
    .messageText, .noteText, .labelText, .loopText { font-size: 13px; }
    .node rect, .node polygon { rx: 6; }
  `,
};

// `channel: "chrome"` starts the Chrome installed on this machine, which is the browser
// the person at the keyboard is using — playwright gives it a temporary profile, but the
// house rule is not to reach for their running app at all. PW_CHANNEL=bundled takes
// playwright's own chromium instead. It renders the same diagrams; text metrics come from
// a different build, so a width may move by a pixel or two.
const CHANNEL = process.env.PW_CHANNEL || "chrome";
const browser = await chromium.launch(
  CHANNEL === "bundled" ? { headless: true } : { channel: CHANNEL, headless: true });
const page = await browser.newPage();
await page.setContent("<html><body></body></html>");
await page.addScriptTag({ content: mermaidJs });
await page.evaluate((cfg) => {
  window.mermaid.initialize({ startOnLoad: false, securityLevel: "loose", ...cfg });
}, THEME);

for (const file of readdirSync(SRC).filter((f) => f.endsWith(".mmd")).sort()) {
  const name = file.replace(/\.mmd$/, "");
  const src = readFileSync(join(SRC, file), "utf8");
  try {
    const svg = await page.evaluate(async ([id, code]) => {
      const { svg } = await window.mermaid.render("m_" + id.replace(/[^a-zA-Z0-9]/g, "_"), code);
      return svg;
    }, [name, src]);
    writeFileSync(join(OUT, name + ".svg"), svg);
    console.log("rendered:", name);
  } catch (e) {
    console.log("FAILED:", name, "—", String(e).split("\n")[0]);
  }
}
await browser.close();
