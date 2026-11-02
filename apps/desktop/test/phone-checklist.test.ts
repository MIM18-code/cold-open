import assert from "node:assert/strict";
import test from "node:test";
import { setupChecklist, TAILSCALE_ADMIN_DNS, TAILSCALE_DOWNLOAD,
  type ChecklistInput } from "../src/renderer/features/phone/checklist.ts";

const complete: ChecklistInput = {
  tailscale: { installed: true, running: true, magicDns: true, https: true },
  remembered: 1,
  folderChosen: true,
};

const plain = (steps: ReturnType<typeof setupChecklist>) =>
  steps.map(step => `${step.title} ${step.detail} ${step.action?.label ?? ""}`).join(" ");

test("every setup step is done when Tailscale, a remembered iPhone and a folder are in place", () => {
  const steps = setupChecklist(complete);
  assert.deepEqual(steps.map(step => step.id), ["installed", "running", "magicDns", "https", "iphone", "folder"]);
  assert.ok(steps.every(step => step.done));
  assert.ok(steps.every(step => !step.action), "a finished step offers no button");
  assert.equal(steps.find(step => step.id === "folder")?.optional, true);
});

test("each missing step is the only one not done and names one plain action", () => {
  const cases: { id: string; input: ChecklistInput; detail: RegExp; url?: string }[] = [
    { id: "installed", detail: /Install Tailscale on this Mac/, url: TAILSCALE_DOWNLOAD,
      input: { ...complete, tailscale: { ...complete.tailscale, installed: false } } },
    { id: "running", detail: /Open Tailscale on this Mac and sign in/,
      input: { ...complete, tailscale: { ...complete.tailscale, running: false } } },
    { id: "magicDns", detail: /Turn on MagicDNS/, url: TAILSCALE_ADMIN_DNS,
      input: { ...complete, tailscale: { ...complete.tailscale, magicDns: false } } },
    { id: "https", detail: /Turn on HTTPS Certificates/, url: TAILSCALE_ADMIN_DNS,
      input: { ...complete, tailscale: { ...complete.tailscale, https: false } } },
    { id: "iphone", detail: /Remember this iPhone/,
      input: { ...complete, remembered: 0 } },
    { id: "folder", detail: /same folder on this Mac and on the iPhone/,
      input: { ...complete, folderChosen: false } },
  ];
  for (const { id, input, detail, url } of cases) {
    const steps = setupChecklist(input), missing = steps.filter(step => !step.done);
    assert.deepEqual(missing.map(step => step.id), [id]);
    assert.match(missing[0]!.detail, detail);
    assert.equal(missing[0]!.action?.url, url);
  }
});

test("the checklist never shows an address, port, tailnet name or file path", () => {
  const text = plain(setupChecklist({ ...complete, remembered: 0, folderChosen: false,
    tailscale: { installed: false, running: false, magicDns: false, https: false } }));
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(text));
  assert.ok(!/:(\d{2,5})\b/.test(text));
  assert.ok(!/\.ts\.net/.test(text));
  assert.ok(!/(?:\/Users\/|\/Volumes\/|~\/)/.test(text));
});
