/** The server's version, as it is advertised to a client. Kept equal to package.json; the test suite checks it. */
export const VERSION = '0.1.0';

/** The MCP endpoint path on the loopback listener. */
export const MCP_PATH = '/mcp';

/**
 * The stateless revision this server is built for (extensibility.md §9). The SDK
 * only selects a 2026 revision through `server/discover`, and only when the server
 * lists it, so it is listed ahead of the 2025 entries. Those stay, so a 2025-era client
 * still negotiates the handshake it knows.
 */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';
