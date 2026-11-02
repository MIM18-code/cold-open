// Paragraph, scene and dual-dialogue IDs. Random UUIDs, so peers never collide.

let generate: () => string = () => globalThis.crypto.randomUUID();

export function newId(): string {
  return generate();
}

/** Replace the generator, for runtimes without crypto.randomUUID or for deterministic tests. */
export function setIdGenerator(next: () => string): () => string {
  const previous = generate;
  generate = next;
  return previous;
}

/** IDs taken from imported files must look like an identifier, not arbitrary text. */
export function isUsableId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
