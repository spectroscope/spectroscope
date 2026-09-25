// Entry point. Deliberately WITHOUT React.StrictMode: the dev double-mount
// would open two socket connections per tab, i.e. two server sessions.

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initDesign } from "./state/designPrefs";
import { installBrowserLog } from "./state/browserLog";
import { installSearchHotkey } from "./components/SearchBox";
import { applyBuildTitle } from "./state/buildTitle";
// Card 430: the views that import these four load from chunks of their own, and
// a chunk's stylesheet would be appended after app.css and win its ties. Here
// they keep the place they had in the entry stylesheet before the split, ahead
// of the app's own rules (surfaceChunks.guard.test.ts holds both halves).
import "@xyflow/react/dist/style.css";
import "./lab/flowmap/flowmap.css";
import "./lab/workflow/workflow.css";
import "./styles/bus.css";
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

// A test build names itself in the window title (card 398); a release keeps
// the title index.html gives it.
void applyBuildTitle();

createRoot(document.getElementById("root")!).render(<App />);
