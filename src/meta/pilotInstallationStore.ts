import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { randomBase64Url, sha256Base64Url } from "./pilotCrypto.js";
import { isKnownAccountUpdateEvent, type MetaAccountUpdate, type StoredAccountUpdate } from "./accountUpdates.js";
import { pilotAccountProfileCommandSchema, describePilotAccountProfile,
  type PilotAccountProfileCommand, type PilotAccountProfileResult, type StoredPilotAccountProfile } from "./pilotAccountProfile.js";

export type PilotInviteRecord = {
  tenantId: string;
  label: string;
  cohortRole: "internal" | "client";
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  reauthorization?: { wabaId: string; phoneNumberId: string; credentialIv: string };
  onboarding?: { flow: "existing_account"; expectedAssets?: { wabaId: string; phoneNumberId: string } };
};

export type EncryptedMetaCredential = {
  ciphertext: string;
  iv: string;
  version: 1;
};

export type PilotInstallationRecord = {
  tenantId: string;
  wabaId: string;
  phoneNumberId: string;
  verifiedName?: string;
  displayPhoneNumber?: string;
  encryptedAccessToken: EncryptedMetaCredential;
  tokenExpiresAt?: string;
  connectedAt: string;
  webhookSubscribedAt: string;
  status: "connected" | "disconnected";
};

export type SanitizedPilotInstallation = Omit<PilotInstallationRecord,
  "encryptedAccessToken" | "wabaId" | "phoneNumberId" | "displayPhoneNumber"> & {
  providerAssetsBound: boolean;
};

type SessionRow = { state_hash: string; expires_at: string; consumed_at: string | null };
type InviteRow = {
  tenant_id: string;
  label: string;
  cohort_role: "internal" | "client";
  created_at: string;
  expires_at: string;
  used_at: string | null;
  reauthorization_json: string | null;
  onboarding_json: string | null;
};
type InstallationRow = {
  tenant_id: string;
  waba_id: string;
  phone_number_id: string;
  verified_name: string | null;
  display_phone_number: string | null;
  access_token_ciphertext: string;
  access_token_iv: string;
  access_token_version: number;
  token_expires_at: string | null;
  connected_at: string;
  webhook_subscribed_at: string;
  status: "connected" | "disconnected";
};
type RouteRow = { tenant_id: string };
type CountRow = { count: number };
type CohortSeatRow = {
  tenant_id: string;
  role: "internal" | "client";
  status: "invited" | "connected";
  expires_at: string;
  invite_hash: string | null;
};
type PilotSeatSnapshot = Pick<CohortSeatRow, "tenant_id" | "status" | "invite_hash">;

export type PilotInstallationObjectStub = {
  createInvite(record: PilotInviteRecord): Promise<void>;
  getInvite(now: string): Promise<PilotInviteRecord | null>;
  revokeInvite(revokedAt: string): Promise<void>;
  beginSession(stateHash: string, expiresAt: string, now: string): Promise<void>;
  consumeSession(stateHash: string, now: string): Promise<PilotInviteRecord | null>;
  markInviteUsed(usedAt: string): Promise<void>;
  putInstallation(record: PilotInstallationRecord): Promise<void>;
  replaceInstallationCredential(record: PilotInstallationRecord, expectedIv: string): Promise<boolean>;
  getInstallation(): Promise<PilotInstallationRecord | null>;
  markInstallationDisconnected(disconnectedAt: string): Promise<void>;
  deleteInstallation(): Promise<void>;
  getAccountProfile(): Promise<StoredPilotAccountProfile | null>;
  getAccountProfileView(): Promise<ReturnType<typeof describePilotAccountProfile> | null>;
  putAccountProfile(command: PilotAccountProfileCommand, now: string): Promise<PilotAccountProfileResult>;
  putWabaRoute(tenantId: string): Promise<boolean>;
  getWabaRoute(): Promise<string | null>;
  deleteWabaRoute(expectedTenantId?: string): Promise<void>;
  recordAccountUpdate(update: Omit<MetaAccountUpdate, "wabaId">, now: string): Promise<void>;
  getAccountUpdates(now: string): Promise<StoredAccountUpdate[]>;
  clearAccountUpdates(expectedTenantId: string): Promise<void>;
  reservePilotSeat(
    tenantId: string,
    role: "internal" | "client",
    expiresAt: string,
    now: string,
    inviteHash: string
  ): Promise<{ ok: true } | { ok: false; code: "TENANT_EXISTS" | "COHORT_LIMIT" }>;
  rotatePilotInvite(
    tenantId: string,
    role: "internal" | "client",
    expiresAt: string,
    now: string,
    inviteHash: string
  ): Promise<{ ok: true; previousInviteHash: string | null } | { ok: false; code: "NOT_PENDING" | "ROLE_MISMATCH" }>;
  markPilotSeatConnected(tenantId: string, connectedAt: string): Promise<void>;
  releasePilotSeat(tenantId: string): Promise<void>;
  listPilotSeats(role: "internal" | "client"): Promise<PilotSeatSnapshot[]>;
};

export type PilotInstallationNamespace = {
  getByName(name: string): PilotInstallationObjectStub;
};

export class WhatsAppPilotInstallationDurableObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  async createInvite(record: PilotInviteRecord): Promise<void> {
    validateTenantId(record.tenantId);
    validateLabel(record.label);
    assertCanonicalIso(record.createdAt);
    assertCanonicalIso(record.expiresAt);
    if (record.expiresAt <= record.createdAt) throw new Error("Invite expiry must be after creation");
    if (record.reauthorization) {
      validateProviderId(record.reauthorization.wabaId);
      validateProviderId(record.reauthorization.phoneNumberId);
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(record.reauthorization.credentialIv)) throw new Error("Invalid credential revision");
    }
    if (record.onboarding) {
      if (record.reauthorization || record.onboarding.flow !== "existing_account") throw new Error("Invalid onboarding flow");
      if (record.onboarding.expectedAssets) {
        validateProviderId(record.onboarding.expectedAssets.wabaId);
        validateProviderId(record.onboarding.expectedAssets.phoneNumberId);
      }
    }
    const existing = this.ctx.storage.sql.exec<InviteRow>("SELECT * FROM invite LIMIT 1").toArray()[0];
    if (existing && !existing.used_at && existing.expires_at > record.createdAt) {
      throw new Error("Invite token already exists");
    }
    this.ctx.storage.sql.exec("DELETE FROM invite");
    this.ctx.storage.sql.exec("DELETE FROM sessions");
    this.ctx.storage.sql.exec(
      `INSERT INTO invite (tenant_id, label, cohort_role, created_at, expires_at, used_at, reauthorization_json, onboarding_json)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      record.tenantId,
      record.label,
      record.cohortRole,
      record.createdAt,
      record.expiresAt,
      record.reauthorization ? JSON.stringify(record.reauthorization) : null,
      record.onboarding ? JSON.stringify(record.onboarding) : null
    );
  }

  async getInvite(now: string): Promise<PilotInviteRecord | null> {
    assertCanonicalIso(now);
    const row = this.ctx.storage.sql.exec<InviteRow>("SELECT * FROM invite LIMIT 1").toArray()[0];
    if (!row || row.used_at || row.expires_at <= now) return null;
    return mapInvite(row);
  }

  async revokeInvite(revokedAt: string): Promise<void> {
    assertCanonicalIso(revokedAt);
    this.ctx.storage.sql.exec("UPDATE invite SET used_at = ? WHERE used_at IS NULL", revokedAt);
    this.ctx.storage.sql.exec("DELETE FROM sessions");
  }

  async beginSession(stateHash: string, expiresAt: string, now: string): Promise<void> {
    validateHash(stateHash);
    assertCanonicalIso(expiresAt);
    const invite = await this.getInvite(now);
    if (!invite || expiresAt > invite.expiresAt) throw new Error("Invite unavailable");
    this.ctx.storage.sql.exec("DELETE FROM sessions");
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions (state_hash, expires_at, consumed_at) VALUES (?, ?, NULL)",
      stateHash,
      expiresAt
    );
  }

  async consumeSession(stateHash: string, now: string): Promise<PilotInviteRecord | null> {
    validateHash(stateHash);
    assertCanonicalIso(now);
    const invite = await this.getInvite(now);
    if (!invite) return null;
    const row = this.ctx.storage.sql.exec<SessionRow>(
      "SELECT state_hash, expires_at, consumed_at FROM sessions LIMIT 1"
    ).toArray()[0];
    if (!row || row.state_hash !== stateHash || row.consumed_at || row.expires_at <= now) return null;
    this.ctx.storage.sql.exec(
      "UPDATE sessions SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL",
      now,
      stateHash
    );
    return invite;
  }

  async markInviteUsed(usedAt: string): Promise<void> {
    assertCanonicalIso(usedAt);
    this.ctx.storage.sql.exec("UPDATE invite SET used_at = ? WHERE used_at IS NULL", usedAt);
  }

  async putInstallation(record: PilotInstallationRecord): Promise<void> {
    validateInstallation(record);
    this.ctx.storage.sql.exec("DELETE FROM installation");
    this.ctx.storage.sql.exec(
      `INSERT INTO installation (
        tenant_id, waba_id, phone_number_id, verified_name, display_phone_number,
        access_token_ciphertext, access_token_iv, access_token_version,
        token_expires_at, connected_at, webhook_subscribed_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.tenantId,
      record.wabaId,
      record.phoneNumberId,
      record.verifiedName ?? null,
      record.displayPhoneNumber ?? null,
      record.encryptedAccessToken.ciphertext,
      record.encryptedAccessToken.iv,
      record.encryptedAccessToken.version,
      record.tokenExpiresAt ?? null,
      record.connectedAt,
      record.webhookSubscribedAt,
      record.status
    );
  }

  async replaceInstallationCredential(record: PilotInstallationRecord, expectedIv: string): Promise<boolean> {
    validateInstallation(record);
    if (record.encryptedAccessToken.iv === expectedIv) return false;
    // The nonce is an opaque credential revision. The conditional SQL update
    // prevents a delayed authorization from replacing a newer credential.
    const result = this.ctx.storage.sql.exec(`UPDATE installation SET
      access_token_ciphertext = ?, access_token_iv = ?, access_token_version = ?,
      token_expires_at = ?, verified_name = ?, display_phone_number = ?, webhook_subscribed_at = ?
      WHERE tenant_id = ? AND waba_id = ? AND phone_number_id = ?
      AND access_token_iv = ? AND status = 'connected'`,
      record.encryptedAccessToken.ciphertext, record.encryptedAccessToken.iv, record.encryptedAccessToken.version,
      record.tokenExpiresAt ?? null, record.verifiedName ?? null, record.displayPhoneNumber ?? null, record.webhookSubscribedAt,
      record.tenantId, record.wabaId, record.phoneNumberId, expectedIv);
    return result.rowsWritten === 1;
  }

  async getInstallation(): Promise<PilotInstallationRecord | null> {
    const row = this.ctx.storage.sql.exec<InstallationRow>("SELECT * FROM installation LIMIT 1").toArray()[0];
    return row ? mapInstallation(row) : null;
  }

  async markInstallationDisconnected(disconnectedAt: string): Promise<void> {
    assertCanonicalIso(disconnectedAt);
    this.ctx.storage.sql.exec("UPDATE installation SET status = 'disconnected' WHERE status = 'connected'");
  }

  async deleteInstallation(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM installation");
    this.ctx.storage.sql.exec("DELETE FROM account_profile");
    this.ctx.storage.sql.exec("DELETE FROM account_profile_commands");
  }

  async getAccountProfile(): Promise<StoredPilotAccountProfile | null> {
    const row = this.ctx.storage.sql.exec<{ snapshot: string }>("SELECT snapshot FROM account_profile LIMIT 1").toArray()[0];
    return row ? JSON.parse(row.snapshot) as StoredPilotAccountProfile : null;
  }

  async getAccountProfileView(): Promise<ReturnType<typeof describePilotAccountProfile> | null> {
    // Read both rows within one synchronous object turn, including during an asset refresh.
    const installation = this.ctx.storage.sql.exec<InstallationRow>("SELECT * FROM installation LIMIT 1").toArray()[0];
    if (!installation) return null;
    const row = this.ctx.storage.sql.exec<{ snapshot: string }>("SELECT snapshot FROM account_profile LIMIT 1").toArray()[0];
    return describePilotAccountProfile(row ? JSON.parse(row.snapshot) as StoredPilotAccountProfile : null, {
      wabaId: installation.waba_id, phoneNumberId: installation.phone_number_id, status: installation.status
    });
  }

  async putAccountProfile(input: PilotAccountProfileCommand, now: string): Promise<PilotAccountProfileResult> {
    const command = pilotAccountProfileCommandSchema.parse(input);
    assertCanonicalIso(now);
    for (const observation of Object.values(command.profile)) {
      if (typeof observation === "object" && "evidence" in observation && observation.evidence.observedAt > now) {
        throw new Error("Profile evidence cannot be future-dated");
      }
    }
    // No await between read/compare/write: one object owns the profile and its receipts.
    return this.ctx.storage.transactionSync(() => {
      const currentRow = this.ctx.storage.sql.exec<{ snapshot: string }>("SELECT snapshot FROM account_profile LIMIT 1").toArray()[0];
      const current = currentRow ? JSON.parse(currentRow.snapshot) as StoredPilotAccountProfile : null;
      const revision = current?.revision ?? 0;
      const installation = this.ctx.storage.sql.exec<InstallationRow>("SELECT * FROM installation LIMIT 1").toArray()[0];
      if (!installation) return { ok: false, code: "INSTALLATION_REQUIRED", revision } as const;
      const request = JSON.stringify(command);
      const prior = this.ctx.storage.sql.exec<{ request: string; revision: number }>(
        "SELECT request, revision FROM account_profile_commands WHERE intent_key = ?", command.intentKey
      ).toArray()[0];
      if (prior) return prior.request === request
        ? { ok: true, revision: prior.revision, replayed: true } as const
        : { ok: false, code: "INTENT_CONFLICT", revision } as const;
      if (command.expectedRevision !== revision) return { ok: false, code: "REVISION_CONFLICT", revision } as const;
      const snapshot: StoredPilotAccountProfile = {
        revision: revision + 1, profile: command.profile,
        wabaId: installation.waba_id, phoneNumberId: installation.phone_number_id, updatedAt: now
      };
      this.ctx.storage.sql.exec("DELETE FROM account_profile");
      this.ctx.storage.sql.exec("INSERT INTO account_profile (snapshot) VALUES (?)", JSON.stringify(snapshot));
      this.ctx.storage.sql.exec("INSERT INTO account_profile_commands (intent_key, request, revision) VALUES (?, ?, ?)",
        command.intentKey, request, snapshot.revision);
      return { ok: true, revision: snapshot.revision, replayed: false } as const;
    });
  }

  async putWabaRoute(tenantId: string): Promise<boolean> {
    validateTenantId(tenantId);
    // No await between read and write: the owning Durable Object claims this
    // route atomically, including when two invitations finish concurrently.
    const owner = this.ctx.storage.sql.exec<RouteRow>("SELECT tenant_id FROM waba_route LIMIT 1").toArray()[0]?.tenant_id;
    if (owner && owner !== tenantId) return false;
    this.ctx.storage.sql.exec("DELETE FROM waba_route");
    this.ctx.storage.sql.exec("INSERT INTO waba_route (tenant_id) VALUES (?)", tenantId);
    return true;
  }

  async getWabaRoute(): Promise<string | null> {
    return this.ctx.storage.sql.exec<RouteRow>("SELECT tenant_id FROM waba_route LIMIT 1").toArray()[0]?.tenant_id ?? null;
  }

  async deleteWabaRoute(expectedTenantId?: string): Promise<void> {
    if (expectedTenantId !== undefined) {
      validateTenantId(expectedTenantId);
      this.ctx.storage.sql.exec("DELETE FROM waba_route WHERE tenant_id = ?", expectedTenantId);
    } else this.ctx.storage.sql.exec("DELETE FROM waba_route");
  }

  async recordAccountUpdate(update: Omit<MetaAccountUpdate, "wabaId">, now: string): Promise<void> {
    assertCanonicalIso(update.occurredAt);
    assertCanonicalIso(now);
    if (!isKnownAccountUpdateEvent(update.event)) throw new Error("Invalid account update event");
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO account_updates (event, occurred_at, received_at) VALUES (?, ?, ?)",
      update.event, update.occurredAt, now
    );
    this.pruneAccountUpdates(now);
    await this.scheduleAccountUpdateCleanup();
  }

  async getAccountUpdates(now: string): Promise<StoredAccountUpdate[]> {
    assertCanonicalIso(now);
    this.pruneAccountUpdates(now);
    await this.scheduleAccountUpdateCleanup();
    return this.ctx.storage.sql.exec<{ event: string; occurred_at: string; received_at: string }>(
      "SELECT event, occurred_at, received_at FROM account_updates ORDER BY occurred_at DESC, event LIMIT 50"
    ).toArray().map(row => ({ event: row.event, occurredAt: row.occurred_at, receivedAt: row.received_at }));
  }

  private pruneAccountUpdates(now: string): void {
    const oldest = new Date(Date.parse(now) - 90 * 24 * 60 * 60 * 1000).toISOString();
    this.ctx.storage.sql.exec("DELETE FROM account_updates WHERE received_at <= ?", oldest);
    this.ctx.storage.sql.exec(`DELETE FROM account_updates WHERE rowid NOT IN
      (SELECT rowid FROM account_updates ORDER BY occurred_at DESC, event LIMIT 50)`);
  }

  private async scheduleAccountUpdateCleanup(): Promise<void> {
    const first = this.ctx.storage.sql.exec<{ received_at: string }>(
      "SELECT received_at FROM account_updates ORDER BY received_at LIMIT 1").toArray()[0];
    if (first) await this.ctx.storage.setAlarm(Date.parse(first.received_at) + 90 * 86400000);
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    this.pruneAccountUpdates(new Date().toISOString());
    await this.scheduleAccountUpdateCleanup();
  }

  async clearAccountUpdates(expectedTenantId: string): Promise<void> {
    validateTenantId(expectedTenantId);
    const owner = this.ctx.storage.sql.exec<RouteRow>("SELECT tenant_id FROM waba_route LIMIT 1").toArray()[0]?.tenant_id;
    if (owner && owner !== expectedTenantId) return;
    this.ctx.storage.sql.exec("DELETE FROM account_updates");
    await this.ctx.storage.deleteAlarm();
  }

  async reservePilotSeat(
    tenantId: string,
    role: "internal" | "client",
    expiresAt: string,
    now: string,
    inviteHash: string
  ): Promise<{ ok: true } | { ok: false; code: "TENANT_EXISTS" | "COHORT_LIMIT" }> {
    validateTenantId(tenantId);
    assertCanonicalIso(expiresAt);
    assertCanonicalIso(now);
    validateHash(inviteHash);
    this.ctx.storage.sql.exec(
      "DELETE FROM cohort_seats WHERE status = 'invited' AND expires_at <= ?",
      now
    );
    const existing = this.ctx.storage.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM cohort_seats WHERE tenant_id = ?",
      tenantId
    ).one().count;
    if (existing > 0) return { ok: false, code: "TENANT_EXISTS" };
    const limit = role === "internal" ? 1 : 3;
    const count = this.ctx.storage.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM cohort_seats WHERE role = ?",
      role
    ).one().count;
    if (count >= limit) return { ok: false, code: "COHORT_LIMIT" };
    this.ctx.storage.sql.exec(
      `INSERT INTO cohort_seats (tenant_id, role, status, expires_at, connected_at, invite_hash)
       VALUES (?, ?, 'invited', ?, NULL, ?)`,
      tenantId,
      role,
      expiresAt,
      inviteHash
    );
    return { ok: true };
  }

  async rotatePilotInvite(
    tenantId: string,
    role: "internal" | "client",
    expiresAt: string,
    now: string,
    inviteHash: string
  ): Promise<{ ok: true; previousInviteHash: string | null } | { ok: false; code: "NOT_PENDING" | "ROLE_MISMATCH" }> {
    validateTenantId(tenantId);
    assertCanonicalIso(expiresAt);
    assertCanonicalIso(now);
    validateHash(inviteHash);
    this.ctx.storage.sql.exec(
      "DELETE FROM cohort_seats WHERE status = 'invited' AND expires_at <= ?",
      now
    );
    const existing = this.ctx.storage.sql.exec<CohortSeatRow>(
      "SELECT tenant_id, role, status, expires_at, invite_hash FROM cohort_seats WHERE tenant_id = ?",
      tenantId
    ).toArray()[0];
    if (!existing || existing.status !== "invited") return { ok: false, code: "NOT_PENDING" };
    if (existing.role !== role) return { ok: false, code: "ROLE_MISMATCH" };
    this.ctx.storage.sql.exec(
      "UPDATE cohort_seats SET expires_at = ?, invite_hash = ? WHERE tenant_id = ? AND status = 'invited'",
      expiresAt,
      inviteHash,
      tenantId
    );
    return { ok: true, previousInviteHash: existing.invite_hash };
  }

  async markPilotSeatConnected(tenantId: string, connectedAt: string): Promise<void> {
    validateTenantId(tenantId);
    assertCanonicalIso(connectedAt);
    this.ctx.storage.sql.exec(
      "UPDATE cohort_seats SET status = 'connected', connected_at = ? WHERE tenant_id = ?",
      connectedAt,
      tenantId
    );
  }

  async releasePilotSeat(tenantId: string): Promise<void> {
    validateTenantId(tenantId);
    this.ctx.storage.sql.exec("DELETE FROM cohort_seats WHERE tenant_id = ?", tenantId);
  }

  async listPilotSeats(role: "internal" | "client"): Promise<PilotSeatSnapshot[]> {
    return this.ctx.storage.sql.exec<PilotSeatSnapshot>(
      "SELECT tenant_id, status, invite_hash FROM cohort_seats WHERE role = ?",
      role
    ).toArray();
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS invite (
        tenant_id TEXT NOT NULL,
        label TEXT NOT NULL,
        cohort_role TEXT NOT NULL CHECK(cohort_role IN ('internal', 'client')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        state_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS installation (
        tenant_id TEXT PRIMARY KEY,
        waba_id TEXT NOT NULL,
        phone_number_id TEXT NOT NULL,
        verified_name TEXT,
        display_phone_number TEXT,
        access_token_ciphertext TEXT NOT NULL,
        access_token_iv TEXT NOT NULL,
        access_token_version INTEGER NOT NULL,
        token_expires_at TEXT,
        connected_at TEXT NOT NULL,
        webhook_subscribed_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('connected', 'disconnected'))
      );
      CREATE TABLE IF NOT EXISTS waba_route (tenant_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS account_updates (
        event TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (event, occurred_at)
      );
      CREATE TABLE IF NOT EXISTS account_profile (snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_profile_commands (
        intent_key TEXT PRIMARY KEY, request TEXT NOT NULL, revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cohort_seats (
        tenant_id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK(role IN ('internal', 'client')),
        status TEXT NOT NULL CHECK(status IN ('invited', 'connected')),
        expires_at TEXT NOT NULL,
        connected_at TEXT,
        invite_hash TEXT
      );
    `);
    const cohortColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(cohort_seats)").toArray();
    if (!cohortColumns.some((column) => column.name === "invite_hash")) {
      this.ctx.storage.sql.exec("ALTER TABLE cohort_seats ADD COLUMN invite_hash TEXT");
    }
    const inviteColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(invite)").toArray();
    if (!inviteColumns.some(column => column.name === "reauthorization_json")) {
      this.ctx.storage.sql.exec("ALTER TABLE invite ADD COLUMN reauthorization_json TEXT");
    }
    if (!inviteColumns.some(column => column.name === "onboarding_json")) {
      this.ctx.storage.sql.exec("ALTER TABLE invite ADD COLUMN onboarding_json TEXT");
    }
  }
}

export function createPilotInstallationRegistry(
  namespace: PilotInstallationNamespace,
  cohortObjectName = "cohort:closed-pilot"
) {
  async function bindInstallation(installation: PilotInstallationRecord): Promise<void> {
    const tenantStub = namespace.getByName(`tenant:${installation.tenantId}`);
    const wabaStub = namespace.getByName(`waba:${installation.wabaId}`);
    const previous = await tenantStub.getInstallation();
    const targetTenant = await wabaStub.getWabaRoute();
    if (targetTenant && targetTenant !== installation.tenantId) {
      throw new Error("WABA is already bound to another tenant");
    }
    if (!await wabaStub.putWabaRoute(installation.tenantId)) throw new Error("WABA is already bound to another tenant");
    await tenantStub.putInstallation(installation);
    if (previous && previous.wabaId !== installation.wabaId) {
      const oldRoute = namespace.getByName(`waba:${previous.wabaId}`);
      await oldRoute.deleteWabaRoute(installation.tenantId);
    }
  }

  return {
    async createReauthorizationInvite(input: { tenantId: string; label: string; expiresAt: string }, now = new Date()): Promise<string> {
      const installation = await this.getInstallation(input.tenantId);
      if (!installation || installation.status !== "connected") throw new Error("Connected installation required");
      const rawToken = randomBase64Url(32);
      const hash = await sha256Base64Url(rawToken);
      const internal = await namespace.getByName(cohortObjectName).listPilotSeats("internal");
      const cohortRole = internal.some(seat => seat.tenant_id === input.tenantId) ? "internal" : "client";
      await namespace.getByName(`invite:${hash}`).createInvite({ ...input, cohortRole, createdAt: now.toISOString(),
        reauthorization: { wabaId: installation.wabaId, phoneNumberId: installation.phoneNumberId,
          credentialIv: installation.encryptedAccessToken.iv } });
      // This renews an existing connection; it does not reserve another seat.
      return rawToken;
    },

    async completeReauthorization(rawToken: string, installation: PilotInstallationRecord, now = new Date()): Promise<boolean> {
      const hash = await sha256Base64Url(rawToken);
      const invite = await namespace.getByName(`invite:${hash}`).getInvite(now.toISOString());
      const pin = invite?.reauthorization;
      if (!invite || !pin || invite.tenantId !== installation.tenantId || pin.wabaId !== installation.wabaId ||
          pin.phoneNumberId !== installation.phoneNumberId) return false;
      if (!await namespace.getByName(`tenant:${installation.tenantId}`)
        .replaceInstallationCredential(installation, pin.credentialIv)) return false;
      await namespace.getByName(`invite:${hash}`).markInviteUsed(now.toISOString());
      return true;
    },

    async createInvite(input: {
      tenantId: string;
      label: string;
      cohortRole: "internal" | "client";
      expiresAt: string;
      onboarding?: PilotInviteRecord["onboarding"];
    }, now = new Date()): Promise<string> {
      const rawToken = randomBase64Url(32);
      const hash = await sha256Base64Url(rawToken);
      const createdAt = now.toISOString();
      const cohort = namespace.getByName(cohortObjectName);
      const reservation = await cohort.reservePilotSeat(
        input.tenantId,
        input.cohortRole,
        input.expiresAt,
        createdAt,
        hash
      );
      if (!reservation.ok) {
        throw new Error(reservation.code === "COHORT_LIMIT"
          ? `Pilot ${input.cohortRole} cohort limit reached`
          : "Pilot tenant already has a cohort seat");
      }
      try {
        await namespace.getByName(`invite:${hash}`).createInvite({ ...input, createdAt });
      } catch (error) {
        await cohort.releasePilotSeat(input.tenantId);
        throw error;
      }
      return rawToken;
    },

    async rotateInvite(input: {
      tenantId: string;
      label: string;
      cohortRole: "internal" | "client";
      expiresAt: string;
      onboarding?: PilotInviteRecord["onboarding"];
    }, now = new Date()): Promise<string> {
      const rawToken = randomBase64Url(32);
      const hash = await sha256Base64Url(rawToken);
      const createdAt = now.toISOString();
      const invite = namespace.getByName(`invite:${hash}`);
      await invite.createInvite({ ...input, createdAt });
      const rotation = await namespace.getByName(cohortObjectName).rotatePilotInvite(
        input.tenantId,
        input.cohortRole,
        input.expiresAt,
        createdAt,
        hash
      );
      if (!rotation.ok) {
        await invite.revokeInvite(createdAt);
        throw new Error(rotation.code === "ROLE_MISMATCH"
          ? "Pilot invitation role cannot change during rotation"
          : "Pilot tenant has no pending invitation to rotate");
      }
      if (rotation.previousInviteHash) {
        await namespace.getByName(`invite:${rotation.previousInviteHash}`).revokeInvite(createdAt);
      }
      return rawToken;
    },

    async getInvite(rawToken: string, now = new Date()): Promise<PilotInviteRecord | null> {
      const hash = await sha256Base64Url(rawToken);
      return namespace.getByName(`invite:${hash}`).getInvite(now.toISOString());
    },

    async beginSession(rawToken: string, rawState: string, expiresAt: string, now = new Date()): Promise<void> {
      const [inviteHash, stateHash] = await Promise.all([
        sha256Base64Url(rawToken),
        sha256Base64Url(rawState)
      ]);
      await namespace.getByName(`invite:${inviteHash}`).beginSession(stateHash, expiresAt, now.toISOString());
    },

    async consumeSession(rawToken: string, rawState: string, now = new Date()): Promise<PilotInviteRecord | null> {
      const [inviteHash, stateHash] = await Promise.all([
        sha256Base64Url(rawToken),
        sha256Base64Url(rawState)
      ]);
      return namespace.getByName(`invite:${inviteHash}`).consumeSession(stateHash, now.toISOString());
    },

    async completeInstallation(
      rawInviteToken: string,
      installation: PilotInstallationRecord,
      completedAt = new Date()
    ): Promise<void> {
      await bindInstallation(installation);
      await namespace.getByName(cohortObjectName)
        .markPilotSeatConnected(installation.tenantId, completedAt.toISOString());
      const inviteHash = await sha256Base64Url(rawInviteToken);
      await namespace.getByName(`invite:${inviteHash}`).markInviteUsed(completedAt.toISOString());
    },

    async refreshInstallation(
      installation: PilotInstallationRecord,
      refreshedAt = new Date()
    ): Promise<void> {
      await bindInstallation(installation);
      await namespace.getByName(cohortObjectName)
        .markPilotSeatConnected(installation.tenantId, refreshedAt.toISOString());
    },

    async getInstallation(tenantId: string): Promise<PilotInstallationRecord | null> {
      validateTenantId(tenantId);
      return namespace.getByName(`tenant:${tenantId}`).getInstallation();
    },

    async getAccountProfile(tenantId: string) {
      validateTenantId(tenantId);
      return namespace.getByName(`tenant:${tenantId}`).getAccountProfileView();
    },

    async putAccountProfile(tenantId: string, command: PilotAccountProfileCommand, now = new Date()) {
      validateTenantId(tenantId);
      return namespace.getByName(`tenant:${tenantId}`).putAccountProfile(command, now.toISOString());
    },

    async reclaimUninstalledPilotSeats(
      role: "internal" | "client",
      reclaimedAt = new Date()
    ): Promise<number> {
      const cohort = namespace.getByName(cohortObjectName);
      const seats = await cohort.listPilotSeats(role);
      let released = 0;
      for (const seat of seats) {
        const installation = await namespace.getByName(`tenant:${seat.tenant_id}`).getInstallation();
        if (installation) continue;
        if (seat.invite_hash) {
          await namespace.getByName(`invite:${seat.invite_hash}`).revokeInvite(reclaimedAt.toISOString());
        }
        await cohort.releasePilotSeat(seat.tenant_id);
        released += 1;
      }
      return released;
    },

    async recordAccountUpdate(update: MetaAccountUpdate, now = new Date()): Promise<void> {
      validateProviderId(update.wabaId);
      await namespace.getByName(`waba:${update.wabaId}`).recordAccountUpdate(
        { event: update.event, occurredAt: update.occurredAt }, now.toISOString());
    },

    async getAccountUpdates(wabaId: string, now = new Date()): Promise<StoredAccountUpdate[]> {
      validateProviderId(wabaId);
      return namespace.getByName(`waba:${wabaId}`).getAccountUpdates(now.toISOString());
    },

    async getWabaBindingOwner(wabaId: string): Promise<string | null> {
      validateProviderId(wabaId);
      return namespace.getByName(`waba:${wabaId}`).getWabaRoute();
    },

    async resolveTenantForWaba(wabaId: string): Promise<string | null> {
      validateProviderId(wabaId);
      const tenantId = await namespace.getByName(`waba:${wabaId}`).getWabaRoute();
      if (!tenantId) return null;
      const installation = await namespace.getByName(`tenant:${tenantId}`).getInstallation();
      return installation?.status === "connected" && installation.wabaId === wabaId ? tenantId : null;
    },

    async disconnect(tenantId: string, disconnectedAt = new Date()): Promise<PilotInstallationRecord | null> {
      const installation = await this.getInstallation(tenantId);
      if (!installation) return null;
      await namespace.getByName(`tenant:${tenantId}`).markInstallationDisconnected(disconnectedAt.toISOString());
      await namespace.getByName(`waba:${installation.wabaId}`).deleteWabaRoute(tenantId);
      await namespace.getByName(cohortObjectName).releasePilotSeat(tenantId);
      return installation;
    },

    async deleteInstallation(tenantId: string): Promise<PilotInstallationRecord | null> {
      const installation = await this.getInstallation(tenantId);
      if (!installation) return null;
      await namespace.getByName(`tenant:${tenantId}`).deleteInstallation();
      await namespace.getByName(`waba:${installation.wabaId}`).clearAccountUpdates(tenantId);
      await namespace.getByName(`waba:${installation.wabaId}`).deleteWabaRoute(tenantId);
      return installation;
    },

    sanitize(installation: PilotInstallationRecord): SanitizedPilotInstallation {
      return {
        tenantId: installation.tenantId,
        ...(installation.verifiedName ? { verifiedName: installation.verifiedName } : {}),
        ...(installation.tokenExpiresAt ? { tokenExpiresAt: installation.tokenExpiresAt } : {}),
        connectedAt: installation.connectedAt,
        webhookSubscribedAt: installation.webhookSubscribedAt,
        status: installation.status,
        providerAssetsBound: true
      };
    }
  };
}

function mapInvite(row: InviteRow): PilotInviteRecord {
  return {
    tenantId: row.tenant_id,
    label: row.label,
    cohortRole: row.cohort_role,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.used_at ? { usedAt: row.used_at } : {}),
    ...(row.reauthorization_json ? { reauthorization: JSON.parse(row.reauthorization_json) as NonNullable<PilotInviteRecord["reauthorization"]> } : {}),
    ...(row.onboarding_json ? { onboarding: JSON.parse(row.onboarding_json) as NonNullable<PilotInviteRecord["onboarding"]> } : {})
  };
}

function mapInstallation(row: InstallationRow): PilotInstallationRecord {
  if (row.access_token_version !== 1) throw new Error("Unsupported credential encryption version");
  return {
    tenantId: row.tenant_id,
    wabaId: row.waba_id,
    phoneNumberId: row.phone_number_id,
    ...(row.verified_name ? { verifiedName: row.verified_name } : {}),
    ...(row.display_phone_number ? { displayPhoneNumber: row.display_phone_number } : {}),
    encryptedAccessToken: {
      ciphertext: row.access_token_ciphertext,
      iv: row.access_token_iv,
      version: 1
    },
    ...(row.token_expires_at ? { tokenExpiresAt: row.token_expires_at } : {}),
    connectedAt: row.connected_at,
    webhookSubscribedAt: row.webhook_subscribed_at,
    status: row.status
  };
}

function validateInstallation(record: PilotInstallationRecord): void {
  validateTenantId(record.tenantId);
  validateProviderId(record.wabaId);
  validateProviderId(record.phoneNumberId);
  assertCanonicalIso(record.connectedAt);
  assertCanonicalIso(record.webhookSubscribedAt);
  if (record.tokenExpiresAt) assertCanonicalIso(record.tokenExpiresAt);
  if (!record.encryptedAccessToken.ciphertext || !record.encryptedAccessToken.iv || record.encryptedAccessToken.version !== 1) {
    throw new Error("Invalid encrypted provider credential");
  }
}

function validateTenantId(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/u.test(value)) throw new Error("Invalid pilot tenant ID");
}

function validateProviderId(value: string): void {
  if (!/^\d{3,32}$/u.test(value)) throw new Error("Invalid Meta provider identifier");
}

function validateLabel(value: string): void {
  if (!value.trim() || value.length > 120 || /[\r\n\u0000]/u.test(value)) throw new Error("Invalid pilot label");
}

function validateHash(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("Invalid hashed token");
}

function assertCanonicalIso(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Expected a canonical UTC ISO timestamp");
  }
}
