// The interchange contract: model output is data, never executable instructions.
// Ported from Writers Block's models.py; keep the two in step.

export const MAX_TRANSCRIPT = 16000;
export const MAX_ELEMENTS = 300;

export const ELEMENT_TYPES = [
  "scene_heading", "action", "character", "dialogue", "parenthetical", "transition", "shot", "note",
] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export const OMISSION_REASONS = ["explicit_correction", "formatting_instruction"] as const;
export type OmissionReason = (typeof OMISSION_REASONS)[number];

export interface Element {
  type: ElementType;
  text: string;
  /** A contiguous substring of the CURRENT transcript. Human-entered elements may leave it empty. */
  source_quote: string;
  uncertainty: string;
}

export interface Omission {
  source_quote: string;
  reason: OmissionReason;
}

export interface Proposal {
  elements: Element[];
  omissions: Omission[];
  warnings: string[];
}

export interface Diagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  element_index: number | null;
}

export class ValidationError extends Error {}

function allowedChar(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code <= 0xd7ff)
    || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

/** Python's str.strip() with no argument: Unicode whitespace at both ends. */
export function pyStrip(value: string): string {
  return value.replace(/^\s+|\s+$/gu, "");
}

/** Reject control characters that cannot safely round-trip through XML 1.0. */
export function cleanText(value: string): string {
  for (const char of value) {
    if (!allowedChar(char.codePointAt(0)!)) throw new ValidationError("Text contains an unsupported control character.");
  }
  return pyStrip(value.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
}

/** Length in code points, the way Python counts a str. */
function length(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

function str(value: unknown, field: string, { min = 0, max = Infinity } = {}): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string.`);
  const size = length(value);
  if (size < min || size > max) throw new ValidationError(`${field} has the wrong length.`);
  return value;
}

function object(value: unknown, field: string, allowed: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ValidationError(`${field} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ValidationError(`${field} has an unexpected field ${key}.`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, field: string, { min = 0, max = Infinity } = {}): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be a list.`);
  if (value.length < min || value.length > max) throw new ValidationError(`${field} has the wrong number of items.`);
  return value;
}

export function makeElement(type: ElementType, text: string, source_quote = "", uncertainty = ""): Element {
  return parseElement({ type, text, source_quote, uncertainty });
}

/** A missing field takes its default; an explicit null is invalid, as in pydantic. */
function field(data: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return key in data ? data[key] : fallback;
}

export function parseElement(raw: unknown): Element {
  const data = object(raw, "element", ["type", "text", "source_quote", "uncertainty"]);
  if (!ELEMENT_TYPES.includes(data.type as ElementType)) throw new ValidationError("Unknown element type.");
  const text = cleanText(str(data.text, "text", { min: 1, max: 8000 }));
  if (!text) throw new ValidationError("An element cannot be empty.");
  return {
    type: data.type as ElementType,
    text,
    source_quote: cleanText(str(field(data, "source_quote", ""), "source_quote", { max: MAX_TRANSCRIPT })),
    uncertainty: cleanText(str(field(data, "uncertainty", ""), "uncertainty", { max: 1000 })),
  };
}

export function parseOmission(raw: unknown): Omission {
  const data = object(raw, "omission", ["source_quote", "reason"]);
  if (!OMISSION_REASONS.includes(data.reason as OmissionReason)) throw new ValidationError("Unknown omission reason.");
  return { source_quote: str(data.source_quote, "source_quote", { min: 1, max: MAX_TRANSCRIPT }), reason: data.reason as OmissionReason };
}

/** Validate untrusted model output into a Proposal, with the limits models.py enforces. */
export function parseProposalObject(raw: unknown): Proposal {
  const data = object(raw, "proposal", ["elements", "omissions", "warnings"]);
  return {
    elements: list(data.elements, "elements", { min: 1, max: MAX_ELEMENTS }).map(parseElement),
    omissions: list(field(data, "omissions", []), "omissions", { max: 100 }).map(parseOmission),
    warnings: list(field(data, "warnings", []), "warnings", { max: 50 }).map((w) => str(w, "warning")),
  };
}

export function copyProposal(proposal: Proposal): Proposal {
  return {
    elements: proposal.elements.map((e) => ({ ...e })),
    omissions: proposal.omissions.map((o) => ({ ...o })),
    warnings: [...proposal.warnings],
  };
}

/** Assigning a new element list re-validates its size, as pydantic's validate_assignment does. */
export function setElements(proposal: Proposal, elements: Element[]): void {
  if (elements.length < 1 || elements.length > MAX_ELEMENTS) throw new ValidationError("elements has the wrong number of items.");
  proposal.elements = elements;
}

/** A deliberately small schema compatible with constrained local decoding. */
export function generationSchema(): Record<string, unknown> {
  const obj = (properties: Record<string, unknown>) => ({
    type: "object", properties, required: Object.keys(properties), additionalProperties: false,
  });
  const string = { type: "string" };
  const element = obj({ type: { type: "string", enum: [...ELEMENT_TYPES] }, text: string, source_quote: string, uncertainty: string });
  const omission = obj({ source_quote: string, reason: { type: "string", enum: [...OMISSION_REASONS] } });
  return obj({
    elements: { type: "array", items: element },
    omissions: { type: "array", items: omission },
    warnings: { type: "array", items: string },
  });
}
