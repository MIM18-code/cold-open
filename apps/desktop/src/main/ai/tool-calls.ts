import { MAX_TOOL_ARGUMENT_CHARS, MAX_TOOL_CALLS, type AiMessage, type AiTool, type AiToolCall, type AiTurn } from "../../shared/channels/ai.ts";
import { AiError } from "./providers.ts";

export const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const namePattern = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
export const toolParseError = () => new AiError("tool-parse", "The model returned an invalid tool call.");

export function validateTools(value: AiTool[] | undefined): AiTool[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 16) throw new AiError("failed", "Invalid tool definitions.");
  const names = new Set<string>();
  return value.map((tool) => {
    if (!tool || typeof tool.name !== "string" || !namePattern.test(tool.name) || names.has(tool.name)
      || typeof tool.description !== "string" || tool.description.length > 4000 || record(tool.parameters).type !== "object") {
      throw new AiError("failed", "Invalid tool definitions.");
    }
    names.add(tool.name);
    return { name: tool.name, description: tool.description, parameters: tool.parameters };
  });
}

/** A model's new calls: the first MAX_TOOL_CALLS are kept and validated, and the rest are only counted. Small models
 * ask to read a dozen scenes at once; refusing the whole batch would push them onto the trimmed-script fallback. */
export function readCalls(raw: unknown, tools: readonly AiTool[]): { toolCalls: AiToolCall[]; skippedCalls?: number } {
  if (!Array.isArray(raw)) throw toolParseError();
  const toolCalls = validateCalls(raw.slice(0, MAX_TOOL_CALLS), tools);
  return { toolCalls, ...(raw.length > MAX_TOOL_CALLS ? { skippedCalls: raw.length - MAX_TOOL_CALLS } : {}) };
}

/** Validate the entire batch before the renderer is allowed to execute any of it. */
export function validateCalls(raw: unknown, tools: readonly AiTool[]): AiToolCall[] {
  if (!Array.isArray(raw) || raw.length > MAX_TOOL_CALLS) throw toolParseError();
  const ids = new Set<string>();
  return raw.map((value): AiToolCall => {
    const call = record(value);
    if (typeof call.id !== "string" || !call.id || call.id.length > 200 || ids.has(call.id)
      || typeof call.name !== "string" || !namePattern.test(call.name) || !tools.some((tool) => tool.name === call.name)) throw toolParseError();
    ids.add(call.id);
    let args = call.arguments;
    if (typeof args === "string") {
      if (args.length > MAX_TOOL_ARGUMENT_CHARS) throw toolParseError();
      try { args = JSON.parse(args); } catch { throw toolParseError(); }
    }
    if (!args || typeof args !== "object" || Array.isArray(args) || JSON.stringify(args).length > MAX_TOOL_ARGUMENT_CHARS) throw toolParseError();
    if (call.signature !== undefined && (typeof call.signature !== "string" || call.signature.length > 128_000)) throw toolParseError();
    if (call.namespace !== undefined && call.namespace !== "screenplay") throw toolParseError();
    if (call.generatedId !== undefined && call.generatedId !== true) throw toolParseError();
    return { id: call.id, name: call.name, arguments: args as Record<string, unknown>,
      ...(typeof call.signature === "string" ? { signature: call.signature } : {}),
      ...(typeof call.namespace === "string" ? { namespace: call.namespace } : {}), ...(call.generatedId ? { generatedId: true } : {}) };
  });
}

export function validateMessages(raw: AiMessage[], tools?: readonly AiTool[]): AiMessage[] {
  if (!Array.isArray(raw) || !raw.length || raw[0]?.role !== "user") throw new AiError("failed", "A request needs a first message from the writer.");
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  const messages = raw.map((message): AiMessage => {
    if (!message || typeof message.content !== "string" || !["user", "assistant", "tool"].includes(message.role)) throw new AiError("failed", "Invalid message.");
    if (message.role === "tool") {
      if (!tools || !message.toolCallId || pending.get(message.toolCallId) !== message.name) throw new AiError("failed", "A tool result needs its matching call.");
      pending.delete(message.toolCallId);
      return { role: "tool", content: message.content, toolCallId: message.toolCallId, name: message.name };
    }
    if (pending.size) throw new AiError("failed", "Tool calls need results before another message.");
    const next: AiMessage = { role: message.role, content: message.content };
    if (message.toolCalls !== undefined) {
      if (!tools || message.role !== "assistant") throw new AiError("failed", "Invalid tool history.");
      next.toolCalls = validateCalls(message.toolCalls, tools);
      for (const call of next.toolCalls) {
        if (seen.has(call.id)) throw new AiError("failed", "Duplicate tool call ID.");
        seen.add(call.id);
        pending.set(call.id, call.name);
      }
    }
    if (message.reasoning !== undefined) {
      if (!tools || message.role !== "assistant" || !Array.isArray(message.reasoning) || message.reasoning.length > 8
        || message.reasoning.some((item) => !item || typeof item.id !== "string" || typeof item.encryptedContent !== "string"
          || !Array.isArray(item.summary) || item.summary.some((row) => !row || typeof row.text !== "string"))) throw new AiError("failed", "Invalid continuation data.");
      next.reasoning = message.reasoning.map((item) => ({ id: item.id, encryptedContent: item.encryptedContent, summary: item.summary.map((row) => ({ text: row.text })) }));
    }
    return next;
  });
  if (pending.size) throw new AiError("failed", "Tool calls need results.");
  return messages;
}

export function responseTools(tools: readonly AiTool[]) {
  return tools.map((tool) => ({ type: "function", ...tool, strict: false }));
}

/** Responses history is explicit because store:false cannot retain a previous response. */
export function responseInput(messages: readonly AiMessage[]): Record<string, unknown>[] {
  return messages.flatMap((message): Record<string, unknown>[] => {
    if (message.role === "tool") return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
    const items: Record<string, unknown>[] = (message.reasoning ?? []).map((item) => ({ type: "reasoning", id: item.id,
      encrypted_content: item.encryptedContent, summary: item.summary.map((row) => ({ type: "summary_text", text: row.text })) }));
    if (message.content) items.push({ role: message.role, content: message.content });
    for (const call of message.toolCalls ?? []) items.push({ type: "function_call", call_id: call.id, name: call.name,
      arguments: JSON.stringify(call.arguments), ...(call.namespace ? { namespace: call.namespace } : {}) });
    return items;
  });
}

export function readResponseTurn(raw: unknown, tools: readonly AiTool[]): AiTurn {
  const data = record(raw);
  if (data.status !== "completed" || !Array.isArray(data.output)) throw new AiError("bad-response", "The model did not complete the answer.");
  const output = data.output.map(record);
  const { toolCalls: calls, skippedCalls } = readCalls(output.filter((item) => item.type === "function_call").map((item) => ({
    id: item.call_id, name: item.name, arguments: item.arguments, ...(item.namespace ? { namespace: item.namespace } : {}),
  })), tools);
  const reasoning = output.filter((item) => item.type === "reasoning" && typeof item.encrypted_content === "string" && typeof item.id === "string")
    .map((item) => ({ id: item.id as string, encryptedContent: item.encrypted_content as string,
      summary: (Array.isArray(item.summary) ? item.summary : []).map(record).filter((row) => typeof row.text === "string").map((row) => ({ text: row.text as string })) }));
  if (calls.length) return { text: "", toolCalls: calls, ...(reasoning.length ? { reasoning } : {}), ...(skippedCalls ? { skippedCalls } : {}) };
  const text = output.filter((item) => item.type === "message").flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map(record).filter((part) => part.type === "output_text" && typeof part.text === "string").map((part) => part.text).join("");
  if (!text.trim()) throw new AiError("bad-response", "The model finished without an answer.");
  return { text };
}
