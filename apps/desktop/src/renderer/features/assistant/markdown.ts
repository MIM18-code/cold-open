// The small part of Markdown models write in answers: paragraphs, lists, headings, tables, bold, italic and code.
// It becomes data for React elements, never HTML, so nothing in an answer can inject markup.

export interface Span { text: string; bold?: boolean; italic?: boolean; code?: boolean }
export type Block =
  | { type: "paragraph"; spans: Span[] }
  | { type: "heading"; spans: Span[] }
  | { type: "list"; ordered: boolean; start?: number; items: Span[][] }
  | { type: "table"; header: Span[][]; rows: Span[][][] }
  | { type: "code"; text: string };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
/** Cells split on pipes a model didn't escape: "\\|" is a literal pipe, "\\\\|" a backslash before a real one. */
function rawCells(line: string): string[] {
  const row = line.trim();
  const out: string[] = [];
  let cell = "";
  for (let i = row.startsWith("|") ? 1 : 0; i < row.length; i++) {
    const char = row[i]!;
    if (char === "\\" && (row[i + 1] === "|" || row[i + 1] === "\\")) { cell += row[i + 1]; i++; }
    else if (char === "|") { out.push(cell.trim()); cell = ""; }
    else cell += char;
  }
  if (cell.trim()) out.push(cell.trim());
  return out;
}
const cells = (line: string) => rawCells(line).map((cell) => spans(cell));
// Checked cell by cell: one regex over the whole row backtracks badly on long runs of spaces.
const isRule = (line: string) => isRow(line) && rawCells(line).every((cell) => /^:?-{2,}:?$/.test(cell));

export function spans(text: string): Span[] {
  const out: Span[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;
  let at = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const token = match[0], index = match.index;
    // Emphasis needs a word edge on both sides: "2*3*4" and "_private_field" stay as written. A rejected
    // match gives back its closing marker, so the next real pair still forms.
    if (!token.startsWith("`") && (/[\p{L}\p{N}]/u.test(text[index - 1] ?? "") || /[\p{L}\p{N}_]/u.test(text[index + token.length] ?? ""))) {
      pattern.lastIndex = index + 1;
      continue;
    }
    if (index > at) out.push({ text: text.slice(at, index) });
    if (token.startsWith("`")) out.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith("**") || token.startsWith("__")) out.push({ text: token.slice(2, -2), bold: true });
    else out.push({ text: token.slice(1, -1), italic: true });
    at = index + token.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let ruled = false;
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", spans: spans(paragraph.join("\n")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      // Fenced text, such as a quoted Fountain excerpt, is shown exactly as written.
      flush();
      const fence = FENCE.exec(line)![1]!, code: string[] = [];
      const closes = new RegExp(`^\\s*\\${fence[0]}{${fence.length},}\\s*$`);
      for (i++; i < lines.length && !closes.test(lines[i]!); i++) code.push(lines[i]!);
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (isRow(line) && isRule(lines[i + 1] ?? "")) {
      flush();
      const header = cells(line), rows: Span[][][] = [];
      for (i += 2; i < lines.length && isRow(lines[i]!); i++) rows.push(cells(lines[i]!));
      i--;
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { flush(); blocks.push({ type: "heading", spans: spans(heading[1]!) }); continue; }
    const item = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (item) {
      flush();
      const ordered = !BULLET.test(line);
      const last = ruled ? undefined : blocks.at(-1);
      ruled = false;
      if (last?.type === "list" && last.ordered === ordered) last.items.push(spans(item[1]!));
      else {
        const start = ordered ? Number(/\d+/.exec(line)![0]) : 1;
        blocks.push({ type: "list", ordered, ...(start !== 1 ? { start } : {}), items: [spans(item[1]!)] });
      }
      continue;
    }
    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) { flush(); ruled = true; continue; }
    paragraph.push(line);
  }
  flush();
  return blocks;
}
