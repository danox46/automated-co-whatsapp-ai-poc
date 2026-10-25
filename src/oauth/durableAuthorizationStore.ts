import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import {
  type AuthorizationCodeRecord,
  type OAuthAuthorizationStore,
  type OAuthAuthorizedSession,
  type RefreshTokenRecord
} from "./authorizationServer.js";
import { randomBase64Url, sha256Base64Url } from "../meta/pilotCrypto.js";
import type { MorningLoginStore, MorningLoginRecordKind } from './morningSessions.js';

type StoredAuthorizationRecord = Omit<AuthorizationCodeRecord, "approvedScopes"> & {
  approvedScopes: string[];
};
type StoredRefreshRecord = Omit<RefreshTokenRecord, "approvedScopes"> & {
  approvedScopes: string[];
};
type PilotSessionRow = {
  tenant_id: string;
  subject: string;
  approved_scopes_json: string;
  expires_at: number;
};

export type OAuthStateObjectStub = OAuthAuthorizationStore & MorningLoginStore & {
  savePilotSession(
    sessionHash: string,
    tenantId: string,
    subject: string,
    approvedScopes: string[],
    expiresAt: number
  ): Promise<void>;
  resolvePilotSession(sessionHash: string, nowSeconds: number): Promise<OAuthAuthorizedSession | null>;
  revokeTenant(tenantId: string): Promise<void>;
};

export type OAuthStateNamespace = {
  getByName(name: string): OAuthStateObjectStub;
};

export class WhatsAppOAuthStateDurableObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  async putMorningLogin(kind: MorningLoginRecordKind, hash: string, encrypted: string, expiresAt: number, nowSeconds: number): Promise<boolean> {
    validateHash(hash);
    if (!['flow', 'session'].includes(kind) || encrypted.length > 65536 || !Number.isInteger(nowSeconds) || !Number.isInteger(expiresAt)) return false;
    this.ctx.storage.sql.exec('DELETE FROM morning_login_records WHERE expires_at <= ?', nowSeconds);
    if (kind === 'session' && expiresAt === 0) {
      const changed = this.ctx.storage.sql.exec<{ record_hash: string }>('UPDATE morning_login_records SET encrypted_json = ? WHERE kind = ? AND record_hash = ? AND expires_at > ? RETURNING record_hash', encrypted, kind, hash, nowSeconds).toArray();
      return changed.length === 1;
    }
    if (expiresAt <= nowSeconds || expiresAt > nowSeconds + (kind === 'flow' ? 300 : 3600)) return false;
    const count = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM morning_login_records WHERE kind = ?', kind).toArray()[0].n;
    if (count >= (kind === 'flow' ? 100 : 1000)) return false;
    this.ctx.storage.sql.exec('INSERT INTO morning_login_records (kind, record_hash, encrypted_json, expires_at) VALUES (?, ?, ?, ?)', kind, hash, encrypted, expiresAt);
    return true;
  }

  async getMorningLogin(kind: MorningLoginRecordKind, hash: string, nowSeconds: number): Promise<string | null> {
    validateHash(hash);
    const row = this.ctx.storage.sql.exec<{ encrypted_json: string }>('SELECT encrypted_json FROM morning_login_records WHERE kind = ? AND record_hash = ? AND expires_at > ?', kind, hash, nowSeconds).toArray()[0];
    return row?.encrypted_json ?? null;
  }

  async consumeMorningLoginFlow(hash: string, nowSeconds: number): Promise<string | null> {
    validateHash(hash);
    const rows = this.ctx.storage.sql.exec<{ encrypted_json: string }>("DELETE FROM morning_login_records WHERE kind = 'flow' AND record_hash = ? AND expires_at > ? RETURNING encrypted_json", hash, nowSeconds).toArray();
    return rows[0]?.encrypted_json ?? null;
  }

  async deleteMorningLoginSession(hash: string): Promise<void> {
    validateHash(hash);
    this.ctx.storage.sql.exec("DELETE FROM morning_login_records WHERE kind = 'session' AND record_hash = ?", hash);
  }

  async saveAuthorizationCode(record: AuthorizationCodeRecord): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO authorization_codes (token_hash, tenant_id, expires_at, record_json)
       VALUES (?, ?, ?, ?)`,
      record.codeHash,
      record.tenantId,
      record.expiresAt,
      JSON.stringify(serializeAuthorization(record))
    );
  }

  async consumeAuthorizationCode(codeHash: string): Promise<AuthorizationCodeRecord | null> {
    const row = this.ctx.storage.sql.exec<{ record_json: string; tenant_id: string }>(
      "SELECT record_json, tenant_id FROM authorization_codes WHERE token_hash = ?",
      codeHash
    ).toArray()[0];
    this.ctx.storage.sql.exec("DELETE FROM authorization_codes WHERE token_hash = ?", codeHash);
    if (!row || this.isTenantRevoked(row.tenant_id)) return null;
    return deserializeAuthorization(JSON.parse(row.record_json) as StoredAuthorizationRecord);
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO refresh_tokens (token_hash, tenant_id, expires_at, record_json)
       VALUES (?, ?, ?, ?)`,
      record.tokenHash,
      record.tenantId,
      record.expiresAt,
      JSON.stringify(serializeRefresh(record))
    );
  }

  async consumeRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const row = this.ctx.storage.sql.exec<{ record_json: string; tenant_id: string }>(
      "SELECT record_json, tenant_id FROM refresh_tokens WHERE token_hash = ?",
      tokenHash
    ).toArray()[0];
    this.ctx.storage.sql.exec("DELETE FROM refresh_tokens WHERE token_hash = ?", tokenHash);
    if (!row || this.isTenantRevoked(row.tenant_id)) return null;
    return deserializeRefresh(JSON.parse(row.record_json) as StoredRefreshRecord);
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM refresh_tokens WHERE token_hash = ?", tokenHash);
  }

  async revokeAccessToken(tokenId: string, expiresAt: number): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO revoked_access_tokens (token_id, expires_at) VALUES (?, ?)",
      tokenId,
      expiresAt
    );
  }

  async isAccessTokenRevoked(tokenId: string): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    this.ctx.storage.sql.exec("DELETE FROM revoked_access_tokens WHERE expires_at <= ?", now);
    return Boolean(this.ctx.storage.sql.exec<{ token_id: string }>(
      "SELECT token_id FROM revoked_access_tokens WHERE token_id = ?",
      tokenId
    ).toArray()[0]);
  }

  async savePilotSession(
    sessionHash: string,
    tenantId: string,
    subject: string,
    approvedScopes: string[],
    expiresAt: number
  ): Promise<void> {
    validateHash(sessionHash);
    validateTenantId(tenantId);
    if (!subject || subject.length > 200 || !Number.isInteger(expiresAt)) throw new Error("Invalid pilot session");
    this.ctx.storage.sql.exec("DELETE FROM revoked_tenants WHERE tenant_id = ?", tenantId);
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO pilot_sessions
       (session_hash, tenant_id, subject, approved_scopes_json, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      sessionHash,
      tenantId,
      subject,
      JSON.stringify([...new Set(approvedScopes)]),
      expiresAt
    );
  }

  async resolvePilotSession(sessionHash: string, nowSeconds: number): Promise<OAuthAuthorizedSession | null> {
    validateHash(sessionHash);
    this.ctx.storage.sql.exec("DELETE FROM pilot_sessions WHERE expires_at <= ?", nowSeconds);
    const row = this.ctx.storage.sql.exec<PilotSessionRow>(
      `SELECT tenant_id, subject, approved_scopes_json, expires_at
       FROM pilot_sessions WHERE session_hash = ?`,
      sessionHash
    ).toArray()[0];
    if (!row || this.isTenantRevoked(row.tenant_id)) return null;
    const approvedScopes = JSON.parse(row.approved_scopes_json) as unknown;
    if (!Array.isArray(approvedScopes) || !approvedScopes.every((scope) => typeof scope === "string")) return null;
    return {
      tenantId: row.tenant_id,
      subject: row.subject,
      approvedScopes: new Set(approvedScopes)
    };
  }

  async revokeTenant(tenantId: string): Promise<void> {
    validateTenantId(tenantId);
    this.ctx.storage.sql.exec("DELETE FROM pilot_sessions WHERE tenant_id = ?", tenantId);
    this.ctx.storage.sql.exec("DELETE FROM authorization_codes WHERE tenant_id = ?", tenantId);
    this.ctx.storage.sql.exec("DELETE FROM refresh_tokens WHERE tenant_id = ?", tenantId);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO revoked_tenants (tenant_id, revoked_at) VALUES (?, ?)",
      tenantId,
      Math.floor(Date.now() / 1000)
    );
  }

  private isTenantRevoked(tenantId: string): boolean {
    return Boolean(this.ctx.storage.sql.exec<{ tenant_id: string }>(
      "SELECT tenant_id FROM revoked_tenants WHERE tenant_id = ?",
      tenantId
    ).toArray()[0]);
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS authorization_codes (
        token_hash TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revoked_access_tokens (
        token_id TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pilot_sessions (
        session_hash TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        approved_scopes_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revoked_tenants (
        tenant_id TEXT PRIMARY KEY,
        revoked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS morning_login_records (
        kind TEXT NOT NULL, record_hash TEXT NOT NULL, encrypted_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY (kind, record_hash)
      );
      CREATE INDEX IF NOT EXISTS authorization_codes_tenant_idx ON authorization_codes(tenant_id);
      CREATE INDEX IF NOT EXISTS refresh_tokens_tenant_idx ON refresh_tokens(tenant_id);
      CREATE INDEX IF NOT EXISTS pilot_sessions_tenant_idx ON pilot_sessions(tenant_id);
    `);
  }
}

export function createDurableOAuthState(namespace: OAuthStateNamespace) {
  const stub = namespace.getByName("oauth:global");
  return {
    store: stub as OAuthAuthorizationStore,
    morningStore: stub as MorningLoginStore,
    async createPilotSession(tenantId: string, approvedScopes: readonly string[], ttlSeconds = 30 * 24 * 60 * 60) {
      const rawSession = randomBase64Url(32);
      const sessionHash = await sha256Base64Url(rawSession);
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      await stub.savePilotSession(sessionHash, tenantId, `pilot:${tenantId}`, [...approvedScopes], expiresAt);
      return { rawSession, expiresAt };
    },
    async resolvePilotSession(rawSession: string, now = new Date()) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(rawSession)) return null;
      return stub.resolvePilotSession(await sha256Base64Url(rawSession), Math.floor(now.getTime() / 1000));
    },
    revokeTenant: (tenantId: string) => stub.revokeTenant(tenantId),
    isAccessTokenRevoked: (tokenId: string) => stub.isAccessTokenRevoked(tokenId)
  };
}

function serializeAuthorization(record: AuthorizationCodeRecord): StoredAuthorizationRecord {
  return { ...record, approvedScopes: [...record.approvedScopes] };
}

function deserializeAuthorization(record: StoredAuthorizationRecord): AuthorizationCodeRecord {
  return { ...record, approvedScopes: new Set(record.approvedScopes) };
}

function serializeRefresh(record: RefreshTokenRecord): StoredRefreshRecord {
  return { ...record, approvedScopes: [...record.approvedScopes] };
}

function deserializeRefresh(record: StoredRefreshRecord): RefreshTokenRecord {
  return { ...record, approvedScopes: new Set(record.approvedScopes) };
}

function validateHash(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("Invalid session hash");
}

function validateTenantId(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/u.test(value)) throw new Error("Invalid tenant identity");
}
