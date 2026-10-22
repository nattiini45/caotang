/**
 * How a host names itself in the words a writer reads. The folder session is shared by the MCP server and the SDK, and a refusal
 * or a notice must name the program the person is running, not the one it was written in: `caotang-mcp` restarts, a script reopens.
 */
export interface FolderVoice {
  /** The program, as a notice names it: `caotang-mcp`. */
  readonly program: string;
  /** The program as it speaks of itself for a file it does not hold: `this server`, `this process`. */
  readonly holder: string;
  /** The sentence that says how to read the folder again after it changed: `Restart caotang-mcp to reload the folder.` */
  readonly reload: string;
  /** When writes that were stopped may resume, completing "until": `caotang-mcp restarts`, `the project is opened again`. */
  readonly reopened: string;
  /** Appended to the refusal for a folder with no project, or empty. */
  readonly noProjectHint: string;
}

/** The MCP server's voice. The words its tests and its operators read. */
export const MCP_VOICE: FolderVoice = {
  program: 'caotang-mcp',
  holder: 'this server',
  reload: 'Restart caotang-mcp to reload the folder.',
  reopened: 'caotang-mcp restarts',
  noProjectHint: 'Pass --create "<name>" to make a new project there.',
};
