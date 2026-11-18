// Chromium's --remote-debugging-port and --remote-debugging-pipe open the page to a debugger, and from the page
// a program can call the services and use the microphone grant. No Electron fuse covers them, so a packaged app
// quits when it is started with either one. index.ts imports this first, so it runs before anything else.
//
// The one exception is an app whose main process already has a debugger attached through --inspect. A release
// build's fuses refuse --inspect, so no shipped app qualifies. The packaged-app test drives the app that way
// before it is sealed, and a program that can attach there needs nothing from the page. Nothing else the
// launching program controls (the environment, other switches) changes the answer.
import { app } from "electron";
import { url as inspectorUrl } from "node:inspector";

const pageDebugger = app.commandLine.hasSwitch("remote-debugging-port") || app.commandLine.hasSwitch("remote-debugging-pipe");
if (app.isPackaged && pageDebugger && !inspectorUrl()) process.exit(1);
