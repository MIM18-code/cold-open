// Which command-line switches a packaged app refuses to start with. No Electron in here, so it can be tested.

/**
 * Whether a command line carries a switch this app refuses (see page-debugger.ts): Chromium's page debugger
 * switches, and the ones that name a program for Chromium to start its helper processes with. The second kind is
 * matched by shape (--browser-subprocess-path, anything ending -cmd-prefix or -launcher), so one Chromium adds later
 * is refused too. Chromium reads a switch written with one dash the same as with two, and trims white space from
 * each argument first, so the rule does both.
 */
export function refusedSwitch(argv: readonly string[]): boolean {
  return argv.some((arg) => /^--?(?:remote-debugging-(?:port|pipe)|browser-subprocess-path|[a-z0-9-]+-cmd-prefix|[a-z0-9-]+-launcher)(?:=|$)/i.test(arg.trim()));
}
