/**
 * Wire-safe tool names (issue #486).
 *
 * Caotang's native tools are named with dots (`doc.write`, `codex.upsert`), but every native-tools route
 * restricts function names: Anthropic Messages to `^[a-zA-Z0-9_-]{1,128}$`, OpenAI Chat/Responses and Gemini's
 * OpenAI-compatible route to `^[a-zA-Z0-9_-]{1,64}$`. A dotted name is refused with HTTP 400 before the model runs.
 *
 * The gateway therefore speaks a per-request codec, above the adapter seam so every route gets it: the request's tool
 * declarations and the tool calls replayed in its history are renamed to their wire form on the way out, and the
 * tool calls the stream assembles are renamed back before anyone above the gateway sees them. Callers only ever see
 * the registry names.
 *
 * The wire form is the name itself when it is already safe; otherwise `.` becomes `__`, any other character outside
 * `[a-zA-Z0-9_-]` becomes `_`, and a name longer than 64 characters is cut to 64. A form that collides
 * with another name in the same request takes a numbered suffix, so the map is always one-to-one and
 * reversible. A wire name the codec never issued (a model inventing a tool) comes back unchanged, and the harness
 * refuses it as an unknown tool, as before.
 */

import type { StreamParser } from './adapters/types.js';
import type { ChatRequest } from './types.js';

/** The strictest rule among the native-tools routes (OpenAI and Gemini; Anthropic allows 128). */
export const WIRE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** The deterministic wire form of one name, before collision checks. */
export function wireToolName(name: string): string {
  return WIRE_TOOL_NAME.test(name) ? name : (name.replace(/\./g, '__').replace(/[^\w-]/g, '_') || 'tool').slice(0, 64);
}

/** One request's name map, both ways. */
export interface ToolNameCodec {
  /** The wire name for a registry name the codec was built with (any other name unchanged). */
  toWire(name: string): string;
  /** The registry name for a wire name; a name the codec never issued comes back unchanged. */
  fromWire(wire: string): string;
}

/** Builds the codec for a set of names. Already-safe names claim their own name first; a renamed one that collides is suffixed. */
export function toolNameCodec(names: Iterable<string>): ToolNameCodec {
  const out = new Map<string, string>();
  const back = new Map<string, string>();
  const add = (name: string, wire: string): void => {
    out.set(name, wire);
    back.set(wire, name);
  };
  const unique = [...new Set(names)];
  for (const name of unique) if (WIRE_TOOL_NAME.test(name)) add(name, name);
  for (const name of unique) {
    if (out.has(name)) continue;
    const base = wireToolName(name);
    let wire = base;
    for (let n = 2; back.has(wire); n += 1) wire = `${base.slice(0, 60)}_${n}`;
    add(name, wire);
  }
  return { toWire: (name) => out.get(name) ?? name, fromWire: (wire) => back.get(wire) ?? wire };
}

/** Every tool name a request carries: its declarations, then the calls replayed in its history. */
export function toolNamesOf(req: ChatRequest): string[] {
  return [...(req.tools ?? []), ...req.messages.flatMap((m) => m.toolCalls ?? [])].map((tool) => tool.name);
}

/** The request with every tool name in its wire form. */
export function encodeToolNames(req: ChatRequest, codec: ToolNameCodec): ChatRequest {
  const rename = <T extends { name: string }>(item: T): T => ({ ...item, name: codec.toWire(item.name) });
  return {
    ...req,
    ...(req.tools && { tools: req.tools.map(rename) }),
    messages: req.messages.map((m) => (m.toolCalls ? { ...m, toolCalls: m.toolCalls.map(rename) } : m)),
  };
}

/** A route's stream parser whose assembled tool calls carry their registry names. */
export function decodingParser(parser: StreamParser, codec: ToolNameCodec): StreamParser {
  return {
    push: (event) => parser.push(event),
    finish: () => {
      const terminal = parser.finish();
      return { ...terminal, ...(terminal.toolCalls && { toolCalls: terminal.toolCalls.map((call) => ({ ...call, name: codec.fromWire(call.name) })) }) };
    },
  };
}
