export interface Pronunciation { from: string; to: string; }
export const PRONUNCIATION_KEY = "tableRead.pronunciations.v1";
export function parsePronunciations(value: unknown): Pronunciation[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0,100).flatMap((item) => {
    if (!item || typeof item.from !== "string" || typeof item.to !== "string") return [];
    const from = item.from.trim(), to = item.to.trim(), key = from.toLocaleLowerCase();
    if (!from || !to || from.length > 80 || to.length > 160 || seen.has(key)) return [];
    seen.add(key); return [{ from, to }];
  });
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One non-cascading substitution pass, matching complete words/phrases, not arbitrary regular expressions. */
export function pronounce(text: string, values: unknown): string {
  const rules = parsePronunciations(values).sort((a,b)=>b.from.length-a.from.length);
  if (!rules.length) return text;
  const lookup = new Map(rules.map((r)=>[r.from.toLocaleLowerCase(),r.to]));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${rules.map((r)=>escape(r.from)).join("|")})(?![\\p{L}\\p{N}_])`,"giu");
  const spoken = text.replace(pattern,(word)=>lookup.get(word.toLocaleLowerCase())??word);
  if(spoken.length>1200)throw new Error("Pronunciation substitutions made this speech too long. Shorten the pronunciations or split the passage.");
  return spoken;
}
export function pronunciationLines(value: unknown): string { return parsePronunciations(value).map((r)=>`${r.from} = ${r.to}`).join("\n"); }
export function parsePronunciationLines(text: string): Pronunciation[] {
  const lines=text.split(/\r?\n/).map((s)=>s.trim()).filter(Boolean);
  if(lines.length>100)throw new Error("Keep at most 100 pronunciation rules per project.");
  const raw=lines.map((line)=>{const at=line.indexOf("=");if(at<1)throw new Error("Write each rule as name = pronunciation.");return{from:line.slice(0,at).trim(),to:line.slice(at+1).trim()};});
  const clean=parsePronunciations(raw);if(clean.length!==raw.length)throw new Error("Use unique names (up to 80 characters) and nonempty pronunciations (up to 160 characters).");return clean;
}
