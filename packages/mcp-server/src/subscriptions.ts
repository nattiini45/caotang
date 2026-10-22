/**
 * Telling a host what a write changed — extensibility.md §9, subscriptions.
 *
 * A host learns of a change in one of two ways, by revision. On 2026-07-28 it opens a `subscriptions/listen` stream and names the
 * URIs it wants; the SDK's handler owns the stream and its filter, and this file hands it the change (`forwardToListeners`). On
 * 2025-era revisions it sends `resources/subscribe` for a URI and the server tells that connection when the URI changed; that
 * connection's server lives as long as the connection, so it keeps the subscriptions and the listener on the project's feed
 * (`forwardChanges`). A server that outlives its request over stdio is served by the same function, and on a 2026-07-28 connection its
 * notices go through the SDK's stream router, which keeps to what each stream asked for.
 *
 * Both exist only with `--allow-writes`: a read-only server never changes the project while it runs, so it advertises neither
 * `resources.subscribe` nor `resources.listChanged`. The feed announces a change after it is on disk, and never a read.
 */

import type { McpServer, ServerNotifier } from '@modelcontextprotocol/server';

import type { ProjectChange } from './changes.js';
import type { ToolRuntime } from './tools.js';
import { MODERN_PROTOCOL_VERSION } from './version.js';

/** Publishes a change on the handler's bus: every open `subscriptions/listen` stream that asked for it is told. */
export function forwardToListeners(notify: ServerNotifier, change: ProjectChange): void {
  if (change.listChanged) notify.resourcesChanged();
  for (const uri of change.updated) notify.resourceUpdated(uri);
}

/** Whether the connection negotiated 2026-07-28 or later: ISO dates, so the strings order as the revisions do. */
function servesModern(server: McpServer): boolean {
  const version = server.server.getNegotiatedProtocolVersion();
  return version !== undefined && version >= MODERN_PROTOCOL_VERSION;
}

/**
 * Wires one long-lived server to the project's feed, until the server closes. A 2025-era connection gets a notice for the URIs it
 * subscribed to and for a changed list; on 2026-07-28 the stream router drops what no stream asked for, so every change is sent.
 */
export function forwardChanges(server: McpServer, runtime: ToolRuntime): void {
  const subscribed = new Set<string>();
  server.server.setRequestHandler('resources/subscribe', (request) => {
    subscribed.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler('resources/unsubscribe', (request) => {
    subscribed.delete(request.params.uri);
    return {};
  });

  const stop = runtime.changes.on((change) => {
    if (change.listChanged) server.sendResourceListChanged();
    const modern = servesModern(server);
    for (const uri of change.updated) {
      if (modern || subscribed.has(uri)) void server.server.sendResourceUpdated({ uri }).catch(() => undefined);
    }
  });
  const previous = server.server.onclose;
  server.server.onclose = () => {
    stop();
    subscribed.clear();
    previous?.();
  };
}
