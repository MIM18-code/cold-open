import { createRoot } from "react-dom/client";

import { app, type Feature } from "./core/app.ts";
import { ErrorBoundary } from "./shell/ErrorBoundary.tsx";
import { Shell } from "./shell/Shell.tsx";
import "./shell/styles.css";
import { watchSystemAccent } from "./shell/system-accent.ts";

const stopAccent = watchSystemAccent();
if (import.meta.hot) import.meta.hot.dispose(stopAccent);

// Every folder under features/ with an index.tsx is a feature. Order is alphabetical; features that care sort with `order`.
const modules = import.meta.glob<{ default: Feature }>("./features/*/index.tsx", { eager: true });
for (const [path, module] of Object.entries(modules)) {
  if (module.default) app.register(module.default);
  else console.warn(`${path} has no default Feature export`);
}

window.addEventListener("error", (event) => console.error("Uncaught", event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => console.error("Unhandled rejection", event.reason));
createRoot(document.getElementById("root")!).render(<ErrorBoundary name="The window"><Shell /></ErrorBoundary>);
void app.start();
// Tests and the developer console reach the app object here.
(window as unknown as { __app: typeof app }).__app = app;
