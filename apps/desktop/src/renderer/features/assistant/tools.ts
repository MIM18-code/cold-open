import { buildCharacterRegistry, characterEvidence, normalizeCharacterName, plainText, sceneSummaries, scenesOf, writeFountain,
  type CharacterIdentity, type Script } from "@screenplay/engine";
import type { AiTool, AiToolCall, ProductionData } from "../../../shared/channels/ai.ts";
import { sceneLabel, visibleScript } from "./context.ts";
import { locate, locateCut, plainMarks, type Suggestion } from "./suggestions.ts";

const sceneParameter = { type: "string", description: "Scene number, or 1-based ordinal when it has no number. Numbers take precedence." };
const definition = (name: string, description: string, properties: Record<string, unknown>, required = Object.keys(properties)): AiTool => ({
  name, description, parameters: { type: "object", properties, required, additionalProperties: false },
});

export function scriptTools(production: boolean): AiTool[] {
  return [
    definition("list_scenes", "List all scenes with number, ordinal, heading, page and speaking characters.", {}),
    definition("read_scene", "Read one scene as Fountain.", { scene: sceneParameter }),
    definition("search_script", "Find case-insensitive text matches across the script, at most 30 lines.", {
      query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 30 },
    }, ["query"]),
    definition("character", "Find a character's speaking scenes, dialogue line count, first appearance and confirmed aliases.", { name: { type: "string" } }),
    ...(production ? [definition("production_data", "Read the chosen Backlot project's breakdown, cast and schedule summary.", {})] : []),
    definition("propose_edit", "Propose a change for the writer to apply. Find must occur exactly once in this scene and fit in one paragraph. An empty replace with a whole line or paragraph as find proposes cutting it (the whole speech when it is the speech's only line). Quote dialogue, not a character cue. Nothing is applied.", {
      scene: sceneParameter, find: { type: "string" }, replace: { type: "string" }, why: { type: "string" },
    }),
  ];
}

export interface ToolContext {
  script(): Script;
  identities?(): readonly CharacterIdentity[];
  productionData?: () => Promise<ProductionData>;
}

export interface ToolExecution {
  result: unknown;
  line: string;
  proposal?: Suggestion;
}

const error = (message: string): ToolExecution => ({ result: { ok: false, error: message }, line: message });

const COMMON = new Set(["the", "and", "but", "for", "with", "you", "are", "was", "his", "her", "its", "this", "that", "not"]);
// Content words by their first four letters, so "holding" meets "holds".
const words = (text: string) => new Set((plainMarks(text).toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? [])
  .filter((word) => !COMMON.has(word)).map((word) => word.slice(0, 4)));

/** The scene paragraph sharing the most words with a missed find, if it shares at least half of them. */
function closestParagraph(paragraphs: Script["paragraphs"], find: string): string | undefined {
  const wanted = words(find);
  let best: { text: string; score: number } | undefined;
  for (const paragraph of paragraphs) {
    const text = plainText(paragraph.runs);
    const have = words(text);
    const score = [...wanted].filter((word) => have.has(word)).length;
    if (score && (!best || score > best.score)) best = { text, score };
  }
  return best && best.score * 2 >= wanted.size ? best.text.slice(0, 600) : undefined;
}

/** Takes a fresh snapshot for every call; no document or filesystem handles reach the model. */
export async function executeTool(call: AiToolCall, context: ToolContext): Promise<ToolExecution> {
  const args = call.arguments;
  const tool = scriptTools(!!context.productionData).find((tool) => tool.name === call.name);
  if (!tool) return error(`Unknown tool: ${call.name}.`);
  const properties = tool.parameters.properties as Record<string, { type: string }>;
  for (const key of tool.parameters.required as string[]) if (!(key in args)) return error(`Missing argument: ${key}.`);
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!property) return error(`Unknown argument: ${key}.`);
    if (key === "scene" && typeof value === "number" && Number.isInteger(value) && value > 0) continue;
    if (property.type === "integer" ? typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 30 : typeof value !== property.type) return error(`Invalid argument: ${key}.`);
  }
  if (call.name === "production_data") {
    const result = await context.productionData!();
    return { result, line: result.ok ? "Read production data" : result.error };
  }
  const source = context.script();
  const script = visibleScript(source);
  const scenes = scenesOf(script.paragraphs);
  const label = (index: number) => sceneLabel(scenes[index]!.number, index + 1, scenes[index]!.heading);
  const sceneAt = (value: unknown): number => {
    const number = String(value).trim();
    const numbered = scenes.map((scene, index) => scene.number === number ? index : -1).filter((index) => index >= 0);
    if (numbered.length > 1) return -2;
    if (numbered.length) return numbered[0]!;
    return /^[1-9]\d*$/.test(number) && Number(number) <= scenes.length ? Number(number) - 1 : -1;
  };
  const fountain = (index: number) => writeFountain({ titlePage: [], paragraphs: script.paragraphs.slice(scenes[index]!.start, scenes[index]!.end) }).trim();
  switch (call.name) {
    case "list_scenes": {
      const summaries = sceneSummaries(script);
      return { result: summaries.map((scene) => ({ number: scene.number ?? String(scene.index + 1), ordinal: scene.index + 1,
        heading: scene.heading, page: scene.page ?? null, characters: scene.characters })), line: `Listed ${scenes.length} scenes` };
    }
    case "read_scene": {
      const index = sceneAt(args.scene);
      if (index < 0) return error(index === -2 ? `Scene number ${args.scene} is duplicated. Renumber the scenes before using it.` : `Scene ${args.scene} does not exist.`);
      return { result: { scene: label(index), text: fountain(index) }, line: `Read ${label(index)}` };
    }
    case "search_script": {
      const query = (args.query as string).trim().toLowerCase();
      if (!query) return error("Search query is empty.");
      const limit = args.limit as number | undefined ?? 30;
      const matches: { scene: string; line: string }[] = [];
      let index = -1;
      for (let p = 0; p < script.paragraphs.length && matches.length < limit; p++) {
        if (scenes[index + 1]?.start === p) index++;
        for (const line of plainText(script.paragraphs[p]!.runs).split("\n")) {
          if (line.toLowerCase().includes(query)) matches.push({ scene: index < 0 ? "Before the first scene" : label(index), line });
          if (matches.length === limit) break;
        }
      }
      return { result: { matches, limitReached: matches.length === limit }, line: `Searched for "${args.query}" · ${matches.length} match${matches.length === 1 ? "" : "es"}${matches.length === limit ? " (limit)" : ""}` };
    }
    case "character": {
      const name = normalizeCharacterName(args.name as string);
      if (!name) return error("Character name is empty.");
      const registry = buildCharacterRegistry(script, context.identities?.() ?? []);
      const identity = registry.characters.find((character) => character.displayName === name || character.aliases.includes(name));
      if (!identity) return error(`No speaking character named ${args.name}.`);
      const evidence = characterEvidence(script, identity, { maxLines: 1, maxDescriptions: 1 });
      const firstIds = new Set([identity.cueIds[0], evidence.descriptions[0]?.paragraphId]);
      const first = script.paragraphs.find((paragraph) => firstIds.has(paragraph.id));
      const firstScene = first ? scenes.findIndex((scene) => scene.paragraphIds.includes(first.id)) : -1;
      return { result: { name: identity.displayName, aliases: identity.aliases, lineCount: evidence.lineCount,
        scenes: scenes.flatMap((scene, index) => evidence.sceneIds.includes(scene.sceneId) ? [label(index)] : []),
        firstAppearance: first ? { scene: firstScene < 0 ? "Before the first scene" : label(firstScene), line: plainText(first.runs) } : null },
      line: `Looked up ${identity.displayName} · ${evidence.lineCount} lines` };
    }
    case "propose_edit": {
      const index = sceneAt(args.scene);
      if (index < 0) return error(index === -2 ? `Scene number ${args.scene} is duplicated.` : `Scene ${args.scene} does not exist.`);
      const find = args.find as string, replace = args.replace as string;
      if (!find.trim()) return error("Find text is empty.");
      if (find === replace) return error("Find and replace are identical.");
      // The same matcher Apply uses: visible paragraph text, without Fountain markup or private notes, so a proposal
      // that passes here is one the writer can apply.
      const proposal: Suggestion = { scene: scenes[index]!.number || String(index + 1), find, replace, why: args.why as string };
      const visibleMatch = !replace.trim() ? locate(script, proposal) : undefined;
      const target = !visibleMatch || "error" in visibleMatch ? undefined : script.paragraphs.find((paragraph) => paragraph.id === visibleMatch.paragraphId);
      const cutting = visibleMatch && (!target || plainMarks(plainText(target.runs)).trim() === plainMarks(find).trim());
      const found = cutting ? locateCut(source, proposal) : locate(source, proposal);
      if ("error" in found) {
        const message = `${found.error} Copy an exact passage from one paragraph of ${label(index)}, as plain text without Fountain formatting.`;
        const closest = closestParagraph(script.paragraphs.slice(scenes[index]!.start, scenes[index]!.end), find);
        // Small models give up after a miss; the nearest real paragraph lets them retry with exact text.
        return closest ? { result: { ok: false, error: message, closestParagraph: closest }, line: message } : error(message);
      }
      if ("paragraphIds" in found) {
        proposal.cut = found.cut;
        return { result: { ok: true, scene: label(index), proposed: true, cut: found.cut, removes: found.paragraphIds.length },
          line: `Proposed ${found.cut} cut in ${label(index)}`, proposal };
      }
      return { result: { ok: true, scene: label(index), proposed: true }, line: `Proposed edit in ${label(index)}`, proposal };
    }
    default: return error(`Unknown tool: ${call.name}.`);
  }
}
