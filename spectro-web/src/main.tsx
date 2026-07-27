// Entry point. Deliberately WITHOUT React.StrictMode: the dev double-mount
// would open two socket connections per tab, i.e. two server sessions.

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initDesign } from "./state/designPrefs";
import { installBrowserLog } from "./state/browserLog";
import { installSearchHotkey } from "./components/SearchBox";
import "./tokens.css";
import "./fonts.css";
import "./app.css";
import "./designs.css";

// Apply the saved skin before first render (the index.html guard already did it
// for the initial paint; this keeps the store authoritative across HMR reloads).
initDesign();

// Before the first render, so a throw during mount is already caught. The ring
// is the only record of a browser-side failure: the server log cannot see this
// half of the product, and the moment it would matter most is the moment the
// server is least likely to answer.
installBrowserLog();

// Cmd+F belongs to the view, not to the browser's find bar: this app collapses,
// virtualises and paginates its text, so the native bar searches a DOM that is
// not what the reader sees.
installSearchHotkey();

createRoot(document.getElementById("root")!).render(<App />);
