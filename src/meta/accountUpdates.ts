// Meta account_update reference, checked 26 October 2026:
// https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update/
const EVENTS = new Set([
  "ACCOUNT_DELETED", "ACCOUNT_VIOLATION", "AD_ACCOUNT_LINKED",
  "AUTH_INTL_PRICE_ELIGIBILITY_UPDATE", "BUSINESS_PRIMARY_LOCATION_COUNTRY_UPDATE",
  "DISABLED_UPDATE", "MM_LITE_TERMS_SIGNED", "PARTNER_ADDED", "PARTNER_REMOVED",
  "PARTNER_APP_INSTALLED", "PARTNER_APP_UNINSTALLED",
  "PARTNER_CLIENT_CERTIFICATION_STATUS_UPDATE", "VOLUME_BASED_PRICING_TIER_UPDATE"
]);

export type MetaAccountUpdate = { wabaId: string; event: string; occurredAt: string };
export type StoredAccountUpdate = { event: string; occurredAt: string; receivedAt: string };

export function isKnownAccountUpdateEvent(event: string): boolean { return EVENTS.has(event); }

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const providerId = (value: unknown): string | null =>
  typeof value === "string" && /^\d{3,32}$/u.test(value) ? value : null;

/** Only call after the existing Meta signature/envelope verification succeeds.
 * This records observations; it never grants access, creates tenants or changes
 * an installation's connection state based on delayed provider announcements.
 */
export async function persistMetaAccountUpdates(payload: unknown, appId: string,
  persist: (update: MetaAccountUpdate) => Promise<void>): Promise<void> {
  const envelope = record(payload);
  if (envelope?.object !== "whatsapp_business_account") return;
  for (const candidate of array(envelope.entry)) {
    const entry = record(candidate);
    const time = entry?.time;
    if (typeof time !== "number" || !Number.isSafeInteger(time) || time <= 0 || time > 4_102_444_800) continue;
    for (const rawChange of array(entry?.changes)) {
      const change = record(rawChange);
      const value = record(change?.value);
      const event = value?.event;
      if (change?.field !== "account_update" || typeof event !== "string" || !EVENTS.has(event)) continue;
      const info = record(value?.waba_info);
      // Partner callbacks can use the partner portfolio as entry.id. It is not
      // the customer's WABA and must never become an installation routing key.
      const partnerAssetEvent = ["PARTNER_ADDED", "PARTNER_REMOVED", "PARTNER_APP_INSTALLED", "PARTNER_APP_UNINSTALLED"].includes(event);
      const wabaId = partnerAssetEvent
        ? providerId(info?.waba_id)
        : providerId(entry?.id);
      if (!wabaId) continue;
      if (event === "PARTNER_APP_INSTALLED" || event === "PARTNER_APP_UNINSTALLED") {
        if (!appId || info?.partner_app_id !== appId) continue;
      }
      await persist({ wabaId, event, occurredAt: new Date(time * 1000).toISOString() });
    }
  }
}
