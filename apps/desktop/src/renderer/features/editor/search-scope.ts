import { characterName, plainText, scenesOf, type Paragraph, type TextPosition } from "@screenplay/engine";
import type { Match } from "./rules.ts";
export type SearchScope = "all" | "scene" | "selection" | "character" | "dialogue" | "action";
export interface SearchContext { sceneId?: string | null; character?: string; from?: TextPosition | null; to?: TextPosition | null; }
export function scopedMatches(paragraphs: readonly Paragraph[], matches: readonly Match[], scope: SearchScope, context: SearchContext): Match[] {
  if (scope === "all") return [...matches];
  const byId = new Map(paragraphs.map((p,i)=>[p.id,{p,i}]));
  const scene = scope === "scene" ? scenesOf(paragraphs).find((s)=>s.sceneId===context.sceneId) : undefined;
  const sceneIds = new Set(scene?.paragraphIds ?? []);
  const speakers = new Map<string,string>(); let speaker="";
  if (scope === "character") for (const p of paragraphs) {
    if(p.type==="character")speaker=characterName(plainText(p.runs));
    else if(p.type==="dialogue"||p.type==="lyrics")speakers.set(p.id,speaker);
    else if(!["parenthetical","note","synopsis"].includes(p.type))speaker="";
  }
  const from=context.from,to=context.to;
  const first=from?byId.get(from.paragraphId)?.i:undefined,last=to?byId.get(to.paragraphId)?.i:undefined;
  return matches.filter((match)=>{
    const found=byId.get(match.paragraphId);if(!found)return false;
    if(scope==="scene")return sceneIds.has(match.paragraphId);
    if(scope==="dialogue")return found.p.type==="dialogue"||found.p.type==="lyrics";
    if(scope==="action")return found.p.type==="action";
    if(scope==="character")return !!context.character&&speakers.get(match.paragraphId)===context.character.toUpperCase().trim();
    if(scope==="selection")return from&&to&&first!==undefined&&last!==undefined&&found.i>=first&&found.i<=last&&
      (found.i!==first||match.from>=from.offset)&&(found.i!==last||match.to<=to.offset);
    return false;
  });
}
