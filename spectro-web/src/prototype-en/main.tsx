// Standalone entry for the React Flow System-Map prototype. It reuses the app's
// design tokens + genome skins (so the skin switcher works) and the shared
// labScene reducer, but mounts ONLY the prototype — no websocket, no backend.
// Open it at /prototype-en.html on the Vite dev server.

import { createRoot } from "react-dom/client";
import "../tokens.css";
import "../fonts.css";
import "../designs.css";
import "@xyflow/react/dist/style.css";
import "./prototype.css";
import { SystemFlow } from "./SystemFlow";

createRoot(document.getElementById("root")!).render(<SystemFlow />);
