import { z } from "zod";

const evidence = z.strictObject({
  source: z.enum(["owner", "provider"]),
  ref: z.string().min(3).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u),
  observedAt: z.iso.datetime({ precision: 3 })
});
const party = z.union([
  z.strictObject({ value: z.literal("unverified") }),
  z.strictObject({ value: z.enum(["morning", "client", "upstream-partner"]), evidence })
]);
const funding = z.union([
  z.strictObject({ value: z.literal("unverified") }),
  z.strictObject({ value: z.enum(["recorded", "provider-unavailable"]), evidence })
]);

/** Operator-recorded evidence, never a grant, funding instruction or charge. */
export const pilotAccountProfileSchema = z.strictObject({
  model: z.enum(["internal-demo", "morning-managed", "client-direct"]),
  phoneOwner: party,
  messagingAccountOwner: party,
  metaPayer: party,
  funding
});
export const pilotAccountProfileCommandSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  intentKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/u),
  profile: pilotAccountProfileSchema
});
export type PilotAccountProfile = z.infer<typeof pilotAccountProfileSchema>;
export type PilotAccountProfileCommand = z.infer<typeof pilotAccountProfileCommandSchema>;
export type StoredPilotAccountProfile = {
  revision: number;
  profile: PilotAccountProfile;
  wabaId: string;
  phoneNumberId: string;
  updatedAt: string;
};
export type PilotAccountProfileResult =
  | { ok: true; revision: number; replayed: boolean }
  | { ok: false; code: "INSTALLATION_REQUIRED" | "REVISION_CONFLICT" | "INTENT_CONFLICT"; revision: number };

export function describePilotAccountProfile(
  stored: StoredPilotAccountProfile | null,
  installation: { wabaId: string; phoneNumberId: string; status: string }
) {
  if (!stored) return { profile: null, revision: 0, reviewState: "not-recorded" as const };
  const profile = pilotAccountProfileSchema.parse(stored.profile);
  const assetsMatch = stored.wabaId === installation.wabaId && stored.phoneNumberId === installation.phoneNumberId;
  const missing = (["phoneOwner", "messagingAccountOwner", "metaPayer", "funding"] as const)
    .filter(field => profile[field].value === "unverified" || profile[field].value === "provider-unavailable");
  const mismatch = profile.model === "client-direct"
    ? (["phoneOwner", "messagingAccountOwner", "metaPayer"] as const)
      .filter(field => !["client", "unverified"].includes(profile[field].value))
    : profile.model === "morning-managed"
      ? (["phoneOwner", "messagingAccountOwner", "metaPayer"] as const)
        .filter(field => profile[field].value === "client")
      : [];
  return {
    profile, revision: stored.revision, updatedAt: stored.updatedAt,
    evidenceBasis: "operator-recorded" as const,
    assetsMatch,
    reviewState: !assetsMatch || installation.status !== "connected" ? "needs-reverification"
      : mismatch.length ? "model-mismatch" : missing.length ? "needs-evidence" : "evidence-recorded",
    missingEvidence: missing, modelMismatch: mismatch,
    // A profile is continuity data, not payment collection or a commercial launch decision.
    billingCollection: "not-configured" as const
  };
}
