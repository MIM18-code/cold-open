// Tells trusted-program.ts that this is a packaged app. index.ts imports this before any service starts a program.
// Whether the build is sealed is read from the running process's signature the first time a program is checked.
import { app } from "electron";

import { configurePackagedApp, ownTeam } from "./trusted-program.ts";

if (app.isPackaged) configurePackagedApp({ team: ownTeam(process.pid) });
