import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BacklotClient, runFileFor, stageDraft, validateConnection, validateOptions } from "../src/main/backlot/client.ts";
test('Backlot connection and option validation refuse remote endpoints, duplicate matches and bad revisions', () => { assert.throws(() => validateConnection({ url: 'https://example.com', token: 'a'.repeat(32), pid: 22, project: '/x' }, '/x')); assert.match(runFileFor('/home/josh/Film/project.json', '/home/josh'), /Film-[a-f0-9]{64}\.json$/); assert.throws(() => validateOptions({ castMode: 'add', revisionLabel: 'Blue', omitSceneIds: [], sceneDecisions: [{ incomingNumber: '1', action: 'match', sceneId: 'x' }, { incomingNumber: '2', action: 'match', sceneId: 'x' }] }), /only once/); });
test('Backlot preview and apply send the exact same captured source and options with a server plan token', async () => { const calls: any[] = []; const fetcher = (async (url: any, init: any) => { calls.push([url, init]); return new Response(JSON.stringify({ revision: 7, planToken: 'token', plan: { unresolved: [] } }), { status: 201 }); }) as typeof fetch; const c = new BacklotClient({ url: 'http://127.0.0.1:4777', token: 'secret' }, fetcher); const options = validateOptions({ castMode: 'add', revisionLabel: 'Blue', omitSceneIds: [], sceneDecisions: [] }); await c.plan('/chosen/captured.fdx', options); await c.plan('/chosen/captured.fdx', options, 'token'); const preview = JSON.parse(calls[0][1].body), apply = JSON.parse(calls[1][1].body); assert.equal(preview.plan, true); assert.equal(apply.plan, false); assert.equal(apply.planToken, 'token'); assert.equal(preview.fdxPath, apply.fdxPath); assert.equal(apply.mode, 'merge'); assert.equal(calls[0][1].headers.authorization, 'Bearer secret'); assert.equal(calls[0][1].redirect, 'error'); });
test('immutable handoff files are reused and tampering or links are refused', async () => { const dir = await mkdtemp(join(tmpdir(), 'inklot-handoff-')); try {
    const project = join(dir, 'project.json'), xml = '<FinalDraft><Content/></FinalDraft>';
    await writeFile(project, '{}');
    const path = await stageDraft(project, xml);
    assert.equal(await readFile(path, 'utf8'), xml);
    assert.equal(await stageDraft(project, xml), path);
    await writeFile(path, 'changed');
    await assert.rejects(stageDraft(project, xml), /changed/);
    await rm(path);
    await symlink(project, path);
    await assert.rejects(stageDraft(project, xml));
    await assert.rejects(stageDraft(project, '<!DOCTYPE x><FinalDraft/>'));
}
finally {
    await rm(dir, { recursive: true, force: true });
} });

test('structured production changes travel beside FDX in both preview and apply', async () => {
    const bodies: any[] = [];
    const request = (async (_url: any, init: any) => {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ revision: 8, planToken: 'reviewed', plan: { unresolved: [] } }));
    }) as typeof fetch;
    const client = new BacklotClient({ url: 'http://127.0.0.1:4777', token: 'secret' }, request);
    const options = validateOptions({ castMode: 'add', revisionLabel: '', omitSceneIds: [], sceneDecisions: [] });
    const changes = { version: 1, baselineSentAt: null, scenes: [{ sceneId: 'stable', kinds: ['added'] }] };
    await client.plan('/draft.fdx', options, undefined, changes);
    await client.plan('/draft.fdx', options, 'reviewed', changes);
    assert.deepEqual(bodies[0].productionChanges, changes);
    assert.deepEqual(bodies[1].productionChanges, changes);
    assert.equal(bodies[1].fdxPath, '/draft.fdx');
});
