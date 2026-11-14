export const invitationMachine = {
  table: {
    id: 'sync-server.invitation', initial: 'pending', final: [],
    on: {
      pending: { grant: ['pending', 'claimed'], claim: ['claimed'], revoke: ['revoked'] },
      claimed: { grant: ['claimed'], revoke: ['revoked'] },
      revoked: { grant: ['pending', 'claimed'] },
    },
  },
  step(state, event) {
    if (event.type === 'grant') return { kind: state.kind === 'claimed' || event.hasAccount ? 'claimed' : 'pending' };
    if (event.type === 'claim' && state.kind === 'pending') return { kind: 'claimed' };
    if (event.type === 'revoke' && state.kind !== 'revoked') return { kind: 'revoked' };
    return state;
  },
};

export function isGithubIdentity(value) {
  return value !== null && typeof value === 'object'
    && typeof value.id === 'string' && /^github:[1-9]\d{0,19}$/.test(value.id)
    && typeof value.login === 'string' && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value.login);
}

export function accountOperatorSql(command) {
  if (command.type === 'revoke') {
    if (!/^github:[1-9]\d{0,19}$/.test(command.githubId)) throw new Error('Choose a valid numeric GitHub identity.');
    const revoked = invitationMachine.step({ kind: 'claimed' }, { type: 'revoke' }).kind;
    return `UPDATE invitations SET state = '${revoked}' WHERE github_id = '${command.githubId}';`;
  }
  if (command.type !== 'invite' || !isGithubIdentity(command.identity) || !Number.isSafeInteger(command.limitBytes) || command.limitBytes < 1) throw new Error('Choose a verified GitHub identity and a positive whole-byte allowance.');
  const pending = invitationMachine.step({ kind: 'revoked' }, { type: 'grant', hasAccount: false }).kind;
  const claimed = invitationMachine.step({ kind: 'revoked' }, { type: 'grant', hasAccount: true }).kind;
  return `INSERT INTO invitations (github_id, login, quota_bytes, state)
VALUES ('${command.identity.id}', '${command.identity.login}', ${command.limitBytes}, '${pending}')
ON CONFLICT (github_id) DO UPDATE SET login = excluded.login,
quota_bytes = CASE WHEN invitations.account_id IS NULL THEN excluded.quota_bytes ELSE invitations.quota_bytes END,
state = CASE WHEN invitations.account_id IS NULL THEN '${pending}' ELSE '${claimed}' END;`;
}
