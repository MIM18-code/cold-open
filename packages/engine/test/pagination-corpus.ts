// Page-count and page-break check against Final Draft's own PDFs. Pass a file listing one pair per line, the
// FDX path and the PDF of the same draft separated by a tab:  node test/pagination-corpus.ts ~/pairs.txt [--detail]
// Needs pdftotext (poppler) for the PDF text. Prints only counts and element types, never script text.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { PAGE, paginate, parseFdx, scriptPaginationOptions, type Pagination } from "../src/index.ts";

const list = process.argv[2];
const detail = process.argv.includes("--detail");
if (!list) throw new Error("Usage: node test/pagination-corpus.ts <file listing FDX and PDF paths, tab separated> [--detail]");
const pairs = readFileSync(list, "utf8").split("\n").map((line) => line.split("\t").map((part) => part.trim()))
  .filter((parts): parts is [string, string] => parts.length >= 2 && !!parts[0] && !!parts[1]);

const DROP = new Set(["MORE", "CONT'D", "CONTD", "CONTINUED", "CONT"]);
/** Words that identify a page start: upper case, no numbers (page and scene numbers), no MORE/CONT'D. */
function words(text: string): string[] {
  return text.toUpperCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').split(/\s+/)
    .map((word) => word.replace(/[^A-Z0-9']/g, "").replace(/^'+|'+$/g, ""))
    .filter((word) => word && !/^\d+[A-Z]?$/.test(word) && !DROP.has(word));
}
const KEY = 4;
/** The first two text lines of a PDF page (the page number line, then the first script line). */
const fdPageText = (raw: string[], index: number) => (raw[index] ?? "").split("\n").filter((line) => line.trim()).slice(0, 2).join("\n");
const key = (list: string[]) => list.slice(0, KEY).join(" ");

interface Stream { words: string[]; page: number; type: string; generated: boolean; paragraphLine: number }

/** Every printed line in order with its words, so a Final Draft page start can be located in our layout. */
function stream(pagination: Pagination): Stream[] {
  const out: Stream[] = [];
  const seen = new Map<string, number>();
  pagination.pages.forEach((page, index) => {
    const lines = [...page.lines].sort((a, b) => a.y - b.y || (a.column ?? 0) - (b.column ?? 0));
    for (const line of lines) {
      const count = line.generated ? 0 : (seen.get(line.paragraphId) ?? 0);
      if (!line.generated) seen.set(line.paragraphId, count + 1);
      out.push({ words: words(line.runs.map((run) => run.text).join("")), page: index, type: line.type, generated: !!line.generated, paragraphLine: count });
    }
  });
  return out;
}

function wordsFrom(lines: Stream[], start: number): string[] {
  const out: string[] = [];
  for (let i = start; i < lines.length && out.length < KEY; i++) out.push(...lines[i]!.words);
  return out;
}

const newTally = () => ({ pairs: 0, failed: 0, exact: 0, withinOne: 0, over: 0, under: 0, titlePages: 0, compared: 0, startsMatch: 0, afterMatch: 0, afterMatchSame: 0 });
// Final Draft 13 is the reference. Older versions set Courier at a different pitch, so they are counted apart.
const tallies = { "Final Draft 13": newTally(), "Final Draft 12 and older": newTally() };
const causes = new Map<string, number>();
const rows: string[] = [];

pairs.forEach(([fdxPath, pdfPath], index) => {
  const info = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
  const current = /^Creator:\s*Final Draft 13/m.test(info);
  const tally = tallies[current ? "Final Draft 13" : "Final Draft 12 and older"];
  tally.pairs++;
  try {
    const script = parseFdx(readFileSync(fdxPath, "utf8"));
    const size = /Page size:\s*([\d.]+) x ([\d.]+)/.exec(info);
    const options = scriptPaginationOptions(script);
    if (size) options.page = { ...(options.page ?? PAGE), width: Number(size[1]) / 72, height: Number(size[2]) / 72 };
    const pagination = paginate(script, options);
    const ours = stream(pagination);
    const pdfPagesRaw = execFileSync("pdftotext", ["-q", "-layout", pdfPath, "-"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\f");
    const pdfPages = pdfPagesRaw.map(words);
    while (pdfPages.length && !pdfPages.at(-1)!.length) pdfPages.pop();

    const ourStarts = pagination.pages.map((_, page) => key(wordsFrom(ours, ours.findIndex((line) => line.page === page))));
    // A title page is printed first in the PDF and is not part of the script's pages.
    const title = key(pdfPages[0] ?? []) !== ourStarts[0] && key(pdfPages[1] ?? []) === ourStarts[0] ? 1 : 0;
    tally.titlePages += title;
    const fdPages = pdfPages.slice(title);
    const diff = pagination.pages.length - fdPages.length;
    if (diff === 0) tally.exact++;
    if (Math.abs(diff) <= 1) tally.withinOne++;
    if (diff > 0) tally.over++;
    if (diff < 0) tally.under++;

    let previousMatched = true;
    let firstMiss = -1;
    for (let page = 1; page < Math.min(fdPages.length, pagination.pages.length); page++) {
      const same = key(fdPages[page]!) === ourStarts[page];
      tally.compared++;
      if (same) tally.startsMatch++;
      if (previousMatched) {
        tally.afterMatch++;
        if (same) tally.afterMatchSame++;
        else {
          if (firstMiss < 0) firstMiss = page;
          // Where did Final Draft break? Find its page start in our line stream near our break.
          const ourStart = ours.findIndex((line) => line.page === page);
          const fdKey = key(fdPages[page]!);
          let found = -1;
          for (let d = 0; d < 120 && found < 0; d++) {
            for (const i of [ourStart - d, ourStart + d]) {
              if (i >= 0 && i < ours.length && !ours[i]!.generated && key(wordsFrom(ours, i)) === fdKey) { found = i; break; }
            }
          }
          const ourLast = ours.slice(0, ourStart).reverse().find((line) => !line.generated);
          // Not at one of our line starts: look for it inside a line (Final Draft broke a paragraph we did not).
          let inside = "";
          if (found < 0) {
            const flat: { word: string; line: number }[] = [];
            ours.forEach((line, i) => { if (!line.generated) for (const word of line.words) flat.push({ word, line: i }); });
            // A page that opens with CHARACTER (CONT'D) has the name in front of words that follow it nowhere in ours.
            const target = /\(CONT/i.test(fdPageText(pdfPagesRaw, page + title)) ? fdKey.split(" ").slice(1) : fdKey.split(" ");
            const center = flat.findIndex((entry) => entry.line >= ourStart);
            for (let d = 0; d < 600 && !inside; d++) {
              for (const at of [center - d, center + d]) {
                if (at < 0 || at + target.length > flat.length) continue;
                if (target.every((word, k) => flat[at + k]!.word === word)) {
                  const line = ours[flat[at]!.line]!;
                  inside = `FD ${flat[at]!.line < ourStart ? "earlier" : "later"}, inside ${line.type} line ${line.paragraphLine} | ours ended ${ourLast?.type}`;
                  break;
                }
              }
            }
          }
          const cause = found < 0 ? inside || "not found"
            : `${found < ourStart ? "FD earlier" : "FD later"} | ours ended ${ourLast?.type} | FD starts ${ours[found]!.type} line ${ours[found]!.paragraphLine}`;
          if (current) causes.set(cause, (causes.get(cause) ?? 0) + 1);
          if (detail) rows.push(`  #${index} page ${page + 1}: ${cause}, ${Math.abs(found - ourStart)} lines`);
        }
      }
      previousMatched = same;
    }
    rows.push(`#${index}${current ? "" : " (older Final Draft)"}: ours ${pagination.pages.length}, Final Draft ${fdPages.length}${title ? " (+ title page)" : ""}, first different start: ${firstMiss < 0 ? "none" : `page ${firstMiss + 1}`}`);
  } catch (error) {
    tally.failed++;
    rows.push(`#${index}: failed: ${(error as Error).message.slice(0, 120)}`);
  }
});

const percent = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(1) : "0"}%`;
for (const [name, tally] of Object.entries(tallies)) {
  console.log(name, JSON.stringify({
    ...tally,
    exactRate: percent(tally.exact, tally.pairs - tally.failed),
    withinOneRate: percent(tally.withinOne, tally.pairs - tally.failed),
    pageStartAgreement: percent(tally.startsMatch, tally.compared),
    breakAgreementAfterAMatch: percent(tally.afterMatchSame, tally.afterMatch),
  }, null, 2));
}
for (const row of rows) console.log(row);
console.log("Where Final Draft 13 broke differently (after an agreeing page):");
for (const [cause, count] of [...causes].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${count}  ${cause}`);
