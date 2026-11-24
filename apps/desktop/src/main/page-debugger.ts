// Switches a launching program can pass that no Electron fuse covers. index.ts imports this first, so it runs before
// anything else, and a packaged app started with one of them quits.
//
// Chromium's --remote-debugging-port and --remote-debugging-pipe open the page to a debugger, and from the page a
// program can call the services and use the microphone grant.
//
// Chromium also has switches that name a program for it to start its helper processes with: --browser-subprocess-path
// and --gpu-launcher ran a script planted beside the sealed beta 17 app, and the -cmd-prefix and -launcher family
// works the same way. A program started like that is the app's child, so macOS counts it as the app for microphone
// access. The names are matched by shape, not from a list, so one Chromium adds later is refused too.
//
// The one exception is an app whose main process already has a debugger attached through --inspect. A release
// build's fuses refuse --inspect, so no shipped app qualifies. The packaged-app test drives the app that way
// before it is sealed, and a program that can attach there needs nothing from the page. Nothing else the
// launching program controls (the environment, other switches) changes the answer.
//
// One environment variable is handled here as well. NODE_TLS_REJECT_UNAUTHORIZED=0 makes Node stop checking
// certificates, no fuse covers it, and this process sends API keys and ChatGPT tokens with Node's fetch. A program
// that starts the app with it, and with a proxy named in the environment, could read them on the way out. Node
// reads the variable at each connection, so a packaged app removes it before anything connects.
import { app } from "electron";
import { url as inspectorUrl } from "node:inspector";

import { refusedSwitch } from "./launch-switches.ts";

// Chromium's own reading of the command line is asked as well, for the names known today, so a spelling this file's
// rule misses is still refused.
const named = ["remote-debugging-port", "remote-debugging-pipe", "browser-subprocess-path", "gpu-launcher", "renderer-cmd-prefix",
  "utility-cmd-prefix", "ppapi-plugin-launcher"].some((name) => app.commandLine.hasSwitch(name));
if (app.isPackaged) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
if (app.isPackaged && (named || refusedSwitch(process.argv)) && !inspectorUrl()) process.exit(1);
