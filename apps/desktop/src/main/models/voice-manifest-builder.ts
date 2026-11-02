import { createHash } from "node:crypto";
import { validateVoicePack, type VoicePack } from "./voice-manifest.ts";

interface TreeFile {
  type: string;
  path: string;
  size: number;
  lfs?: { oid: string; size: number };
}
export async function resolveVoiceManifest(packs: VoicePack[], fetchFile: typeof fetch = fetch): Promise<VoicePack[]> {
  const resolved = structuredClone(packs);
  for (const pack of resolved) {
    pack.files = [];
    for (const [sourceIndex, source] of pack.sources.entries()) {
      const revision = source.revision === "UNRESOLVED" ? "main" : source.revision;
      const response = await fetchFile(`https://huggingface.co/api/models/${source.repo}/revision/${revision}`);
      if (!response.ok) throw new Error(`Model revision unavailable: ${source.repo} (${response.status})`);
      const model = await response.json() as { sha: string; cardData?: { license?: string | string[] } };
      if (!/^[a-f0-9]{40}$/.test(model.sha)) throw new Error(`Missing revision for ${source.repo}`);
      source.revision = model.sha;
      source.license = model.cardData?.license ? String(model.cardData.license) : "Not declared in model card; review license files";
      let page: string | null = `https://huggingface.co/api/models/${source.repo}/tree/${source.revision}?recursive=true&expand=true`;
      let count = 0;
      while (page) {
        const listing: Response = await fetchFile(page);
        if (!listing.ok) throw new Error(`Listing failed: ${page}`);
        const entries = await listing.json() as TreeFile[];
        for (const entry of entries) {
          const notice = /^(README\.md|LICENSE(?:\.[^/]+)?|NOTICE(?:\.[^/]+)?)$/i.test(entry.path);
          if (entry.type !== "file" || !notice && !new RegExp(source.include).test(entry.path)) continue;
          if (!notice && !entry.path.startsWith(source.strip)) throw new Error(`Source prefix mismatch: ${entry.path}`);
          let sha256 = entry.lfs?.oid ?? "";
          const size = entry.lfs?.size ?? entry.size;
          if (!/^[a-f0-9]{64}$/.test(sha256)) {
            const path = entry.path.split("/").map(encodeURIComponent).join("/");
            const file = await fetchFile(`https://huggingface.co/${source.repo}/resolve/${source.revision}/${path}`);
            if (!file.ok || !file.body) throw new Error(`File unavailable: ${entry.path}`);
            const hash = createHash("sha256"); let received = 0;
            for await (const chunk of file.body) { hash.update(chunk); received += chunk.byteLength; }
            if (received !== size) throw new Error(`File size mismatch: ${entry.path}`);
            sha256 = hash.digest("hex");
          }
          const relative = entry.path.slice(source.strip.length);
          // FluidAudio expects ANE and shared frontend directories as siblings.
          const localPath = notice ? `notices/source-${sourceIndex}/${entry.path}`
            : pack.id === "kokoro" && entry.path.startsWith("ANE/") ? `kokoro-82m-coreml/${entry.path}`
            : [source.destination, relative].filter(Boolean).join("/");
          pack.files.push({ source: sourceIndex, path: entry.path, localPath, size, sha256 });
          if (!notice) count++;
        }
        page = /<([^>]+)>; rel="next"/.exec(listing.headers.get("link") ?? "")?.[1] ?? null;
      }
      if (!count) throw new Error(`No model files matched ${source.repo}: ${source.include}`);
    }
    // Some Ming conversions carry CAMPPlus too; retain the explicitly pinned source.
    pack.files = pack.files.filter((f, i, all) => all.findLastIndex((other) => other.localPath === f.localPath) === i);
    delete pack.unresolved;
    validateVoicePack(pack);
  }
  return resolved;
}
