import { isGithubIdentity, type GithubIdentity } from '../account-policy.mjs';

export interface DurableAccount {
  id: string;
  githubId: string;
  login: string;
  revision: number;
  usage: { limitBytes: number; usedBytes: number; reservedBytes: number };
}

interface AccountRow {
  account_id: string;
  github_id: string;
  login: string;
  session_revision: number;
  quota_limit: number;
  quota_used: number;
  quota_reserved: number;
}

const ACTIVE_ACCOUNT = `SELECT a.* FROM accounts a JOIN invitations i ON i.account_id = a.account_id
WHERE a.status = 'active' AND i.state = 'claimed'`;

function account(row: AccountRow | null): DurableAccount | null {
  return row === null ? null : {
    id: row.account_id, githubId: row.github_id, login: row.login, revision: row.session_revision,
    usage: { limitBytes: row.quota_limit, usedBytes: row.quota_used, reservedBytes: row.quota_reserved },
  };
}

export class AccountRegistry {
  private readonly db: Pick<D1Database, 'prepare' | 'batch'>;

  constructor(db: Pick<D1Database, 'prepare' | 'batch'>) {
    this.db = db;
  }

  async claim(identity: GithubIdentity): Promise<DurableAccount | null> {
    if (!isGithubIdentity(identity)) return null;
    await this.db.batch([
      this.db.prepare(`INSERT INTO accounts (account_id, github_id, login, quota_limit)
        SELECT ?, github_id, ?, quota_bytes FROM invitations
        WHERE github_id = ? AND state = 'pending' AND account_id IS NULL
        ON CONFLICT (github_id) DO NOTHING`).bind(crypto.randomUUID(), identity.login, identity.id),
      this.db.prepare(`UPDATE invitations SET state = 'claimed',
        account_id = (SELECT account_id FROM accounts WHERE github_id = ? AND status = 'active')
        WHERE github_id = ? AND state = 'pending'
        AND EXISTS (SELECT 1 FROM accounts WHERE github_id = ? AND status = 'active')`).bind(identity.id, identity.id, identity.id),
      this.db.prepare(`UPDATE accounts SET login = ? WHERE github_id = ? AND status = 'active'
        AND EXISTS (SELECT 1 FROM invitations WHERE github_id = ? AND state = 'claimed')`).bind(identity.login, identity.id, identity.id),
    ]);
    return account(await this.db.prepare(`${ACTIVE_ACCOUNT} AND a.github_id = ?`).bind(identity.id).first<AccountRow>());
  }

  async session(id: string, githubId: string, revision: number): Promise<DurableAccount | null> {
    if (!Number.isSafeInteger(revision) || revision < 1) return null;
    return account(await this.db.prepare(`${ACTIVE_ACCOUNT} AND a.account_id = ? AND a.github_id = ? AND a.session_revision = ?`).bind(id, githubId, revision).first<AccountRow>());
  }

  async current(id: string): Promise<DurableAccount | null> {
    return account(await this.db.prepare(`${ACTIVE_ACCOUNT} AND a.account_id = ?`).bind(id).first<AccountRow>());
  }

  async revokeSessions(id: string, revision: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE accounts SET session_revision = session_revision + 1
      WHERE account_id = ? AND session_revision = ? AND status = 'active'`).bind(id, revision).run();
    return result.meta.changes === 1;
  }
}
