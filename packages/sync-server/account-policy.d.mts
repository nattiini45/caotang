import type { Machine } from '@caotang/machine';

export interface GithubIdentity { id: string; login: string }
export type InvitationState = { kind: 'pending' | 'claimed' | 'revoked' };
export type InvitationEvent = { type: 'grant'; hasAccount: boolean } | { type: 'claim' } | { type: 'revoke' };
export type AccountOperatorCommand = { type: 'invite'; identity: GithubIdentity; limitBytes: number } | { type: 'revoke'; githubId: string };
export const invitationMachine: Machine<InvitationState, InvitationEvent>;
export function isGithubIdentity(value: unknown): value is GithubIdentity;
export function accountOperatorSql(command: AccountOperatorCommand): string;
