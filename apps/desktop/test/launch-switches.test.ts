// A packaged app quits when started with a switch that opens its page to a debugger or names a program for
// Chromium to run as one of its helpers.
import assert from "node:assert/strict";
import { test } from "node:test";

import { refusedSwitch } from "../src/main/launch-switches.ts";

test("debugger and helper-program switches are refused, ordinary launches are not", () => {
  const app = "/Applications/Cold Open.app/Contents/MacOS/Cold Open";
  for (const arg of ["--remote-debugging-port=9222", "--remote-debugging-pipe", "--browser-subprocess-path=/tmp/x", "--gpu-launcher=/tmp/x",
    "--renderer-cmd-prefix=/tmp/x", "--utility-cmd-prefix=/tmp/x", "--ppapi-plugin-launcher=/tmp/x", "--GPU-Launcher=/tmp/x", "--some-future-cmd-prefix",
    "-gpu-launcher=/tmp/x", "-remote-debugging-port=9222", "-browser-subprocess-path=/tmp/x", " --gpu-launcher=/tmp/x", "\t-browser-subprocess-path=/tmp/x\n"])
    assert.equal(refusedSwitch([app, arg]), true, arg);
  for (const argv of [[app], [app, "/Users/w/Scripts/Pilot.screenplay"], [app, "--user-data-dir=/tmp/profile"], [app, "/Users/w/--gpu-launcher=x.fdx"],
    [app, "--inspect=0"], [app, "--launcher-notes"], [app, "gpu-launcher=/tmp/x"]])
    assert.equal(refusedSwitch(argv), false, argv.join(" "));
});
