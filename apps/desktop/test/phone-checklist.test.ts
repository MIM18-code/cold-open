import assert from "node:assert/strict";
import test from "node:test";
import { pairedForAway, setupChecklist, TAILSCALE_ADMIN_DNS, TAILSCALE_DOWNLOAD,
  type ChecklistInput } from "../src/renderer/features/phone/checklist.ts";

const complete: ChecklistInput = {
  tailscale: { installed: true, running: true, magicDns: true, https: true },
  remembered: [{ tailscale: true, lastSeen: 1 }],
  folderChosen: true,
};

const plain = (steps: ReturnType<typeof setupChecklist>) =>
  steps.map(step => `${step.title} ${step.detail} ${step.action?.label ?? ""}`).join(" ");

test("every setup step is done when Tailscale, an iPhone paired through it and a folder are in place", () => {
  const steps = setupChecklist(complete);
  assert.deepEqual(steps.map(step => step.id), ["installed", "running", "magicDns", "https", "iphone", "folder"]);
  assert.ok(steps.every(step => step.done));
  assert.ok(steps.every(step => !step.action), "a finished step offers no button");
  assert.equal(steps.find(step => step.id === "folder")?.optional, true);
});

test("each missing step is the only one not done and says what to do", () => {
  const cases: { id: string; input: ChecklistInput; detail: RegExp; url?: string }[] = [
    { id: "installed", detail: /Install Tailscale on this Mac/, url: TAILSCALE_DOWNLOAD,
      input: { ...complete, tailscale: { ...complete.tailscale, installed: false } } },
    { id: "running", detail: /Open Tailscale on this Mac and sign in, or make an account/,
      input: { ...complete, tailscale: { ...complete.tailscale, running: false } } },
    { id: "magicDns", detail: /turn on MagicDNS\. It gives this Mac a name/, url: TAILSCALE_ADMIN_DNS,
      input: { ...complete, tailscale: { ...complete.tailscale, magicDns: false } } },
    { id: "https", detail: /find HTTPS Certificates and choose Enable HTTPS.*When you pair.*public record/, url: TAILSCALE_ADMIN_DNS,
      input: { ...complete, tailscale: { ...complete.tailscale, https: false } } },
    { id: "iphone", detail: /Install Tailscale on the iPhone.*with the iPhone here at the Mac.*Remember this iPhone/,
      input: { ...complete, remembered: [] } },
    { id: "folder", detail: /^Optional\..*can’t reach the Mac.*once iCloud syncs.*iPhone’s Status screen/,
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
  const text = plain(setupChecklist({ ...complete, remembered: [], folderChosen: false, showing: "remembered",
    tailscale: { installed: false, running: false, magicDns: false, https: false } }));
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(text));
  assert.ok(!/:(\d{2,5})\b/.test(text));
  assert.ok(!/\.ts\.net/.test(text));
  assert.ok(!/(?:\/Users\/|\/Volumes\/|~\/)/.test(text));
});

test("only an iPhone that paired through Tailscale and has connected works away from home", () => {
  assert.equal(pairedForAway([]), false);
  assert.equal(pairedForAway([{ lastSeen: 5 }]), false, "a home pairing stops at the Mac's network");
  assert.equal(pairedForAway([{ tailscale: true, lastSeen: 0 }]), false, "a code shown and never scanned");
  assert.equal(pairedForAway([{ lastSeen: 5 }, { tailscale: true, lastSeen: 5 }]), true);
  const step = (input: Partial<ChecklistInput>) =>
    setupChecklist({ ...complete, ...input }).find(item => item.id === "iphone")!;
  assert.equal(step({ remembered: [{ tailscale: true, lastSeen: 0 }] }).done, false);
});

test("the iPhone step says how to bring Connect through back while a pairing code is showing", () => {
  const detail = (showing?: ChecklistInput["showing"]) =>
    setupChecklist({ ...complete, remembered: [], showing }).find(item => item.id === "iphone")!.detail;
  assert.match(detail("remembered"), /choose Pair another iPhone to bring Connect through back/);
  assert.match(detail("one-off"), /choose Stop sharing \/ revoke link to bring Connect through back/);
  assert.doesNotMatch(detail(), /pairing code is showing/);
});
