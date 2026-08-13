// The local page the spike drives (card 200).
//
// Local testing first: the measured corpus is localhost dev servers, so the
// fixture is one too. It serves four things the PoC needs to prove something
// different with each:
//
//   /                     a page whose content arrives AFTER load, so "navigate
//                         finished" and "content is there" are distinguishable
//   /redirect-to-private  a 302 into RFC-1918 — the hop browse_page cannot see
//   /ads/tracker.js       a request an adblock rule is supposed to eat
//   /slow.json            a fetch the page makes, for the Promise-await check
//
// Plain node http on purpose: the spike must not need an install to run.

const http = require("http");

const PAGE = `<!doctype html>
<html>
  <head>
    <title>spectro browser spike</title>
    <script src="/ads/tracker.js"></script>
  </head>
  <body style="font:14px system-ui;padding:24px">
    <h1 id="heading">loading…</h1>
    <button id="counter" data-count="0">clicked 0 times</button>
    <input id="field" value="" />
    <p id="echo"></p>
    <script>
      // A page-context global. An eval that cannot see this is not running in
      // the page, it is running somewhere else that merely has a DOM.
      window.__PAGE_MARKER__ = "page-context-ok";

      // Content that arrives late, so a screenshot taken too early is visibly
      // wrong rather than subtly wrong.
      setTimeout(() => {
        document.getElementById("heading").textContent = "spike fixture ready";
      }, 300);

      document.getElementById("counter").addEventListener("click", (e) => {
        const n = Number(e.target.dataset.count) + 1;
        e.target.dataset.count = String(n);
        e.target.textContent = "clicked " + n + " times";
      });

      // The React-shaped listener: it reacts to a dispatched input event, not
      // to a value assignment. This is what the "native setter" half of the
      // pinned semantics exists for.
      document.getElementById("field").addEventListener("input", (e) => {
        document.getElementById("echo").textContent = "echo:" + e.target.value;
      });
    </script>
  </body>
</html>`;

function start(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/redirect-to-private") {
        // Into RFC-1918. The fence must see THIS, not just the address the
        // agent was handed.
        res.writeHead(302, { Location: "http://192.168.1.1/admin" });
        res.end();
        return;
      }
      if (req.url === "/ads/tracker.js") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end('window.__TRACKER_RAN__ = true;');
        return;
      }
      if (req.url === "/slow.json") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"slow":"arrived"}');
        }, 250);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PAGE);
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

module.exports = { start };
