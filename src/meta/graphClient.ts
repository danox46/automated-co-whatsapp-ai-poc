export type MetaGraphClientOptions = {
  appId: string;
  appSecret: string;
  graphVersion: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type MetaAccessToken = {
  accessToken: string;
  expiresAt?: string;
};

export type MetaPhoneAsset = {
  id: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
};

export type MetaProviderResult = {
  messageRef: string;
  status: "accepted";
};

export type MetaMediaMetadata = {
  url: string;
  mimeType: string;
  sha256?: string;
  fileSize?: number;
};

export class MetaGraphError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryable: boolean
  ) {
    super(code);
    this.name = "MetaGraphError";
  }
}

export function createMetaGraphClient(options: MetaGraphClientOptions) {
  if (!/^v\d+\.\d+$/u.test(options.graphVersion)) {
    throw new Error("META_GRAPH_API_VERSION must look like v25.0");
  }
  const request = options.fetch ?? fetch;
  const base = `https://graph.facebook.com/${options.graphVersion}`;

  return {
    async exchangeEmbeddedSignupCode(code: string): Promise<MetaAccessToken> {
      if (!/^[A-Za-z0-9._-]{20,4096}$/u.test(code)) throw new Error("Invalid Meta authorization code");
      const response = await boundedFetch(
        request,
        `${base}/oauth/access_token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: options.appId,
            client_secret: options.appSecret,
            code
          })
        },
        options.timeoutMs
      );
      const body = await readMetaJson(response);
      const accessToken = readString(body.access_token);
      if (!response.ok || !accessToken) throw metaError(response, body, "META_CODE_EXCHANGE_FAILED");
      const expiresIn = readPositiveNumber(body.expires_in);
      return {
        accessToken,
        ...(expiresIn ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {})
      };
    },

    async verifyPhoneBelongsToWaba(
      accessToken: string,
      wabaId: string,
      phoneNumberId: string
    ): Promise<MetaPhoneAsset> {
      assertProviderId(wabaId, "WABA");
      assertProviderId(phoneNumberId, "phone number");
      const url = new URL(`${base}/${encodeURIComponent(wabaId)}/phone_numbers`);
      url.searchParams.set("fields", "id,display_phone_number,verified_name");
      url.searchParams.set("limit", "100");
      const response = await boundedFetch(request, url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` }
      }, options.timeoutMs);
      const body = await readMetaJson(response);
      if (!response.ok) throw metaError(response, body, "META_ASSET_VERIFICATION_FAILED");
      const rows = Array.isArray(body.data) ? body.data : [];
      const match = rows.find((row) => isRecord(row) && row.id === phoneNumberId);
      if (!isRecord(match)) throw new MetaGraphError("META_PHONE_NOT_IN_WABA", 403, false);
      return {
        id: phoneNumberId,
        ...(readString(match.display_phone_number) ? { displayPhoneNumber: readString(match.display_phone_number) as string } : {}),
        ...(readString(match.verified_name) ? { verifiedName: readString(match.verified_name) as string } : {})
      };
    },

    async subscribeApp(accessToken: string, wabaId: string): Promise<void> {
      assertProviderId(wabaId, "WABA");
      const response = await boundedFetch(request, `${base}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` }
      }, options.timeoutMs);
      const body = await readMetaJson(response);
      if (!response.ok || body.success !== true) {
        throw metaError(response, body, "META_WEBHOOK_SUBSCRIPTION_FAILED");
      }
    },

    async isAppSubscribed(accessToken: string, wabaId: string): Promise<boolean> {
      assertProviderId(wabaId, "WABA");
      const response = await boundedFetch(request, `${base}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      }, options.timeoutMs);
      const body = await readMetaJson(response);
      if (!response.ok) throw metaError(response, body, "META_WEBHOOK_SUBSCRIPTION_LOOKUP_FAILED");
      const rows = Array.isArray(body.data) ? body.data.filter(isRecord) : [];
      return rows.some((row) => {
        if (readString(row.id) === options.appId) return true;
        const nested = isRecord(row.whatsapp_business_api_data) ? row.whatsapp_business_api_data : null;
        return nested ? readString(nested.id) === options.appId : false;
      });
    },

    async unsubscribeApp(accessToken: string, wabaId: string): Promise<void> {
      assertProviderId(wabaId, "WABA");
      const response = await boundedFetch(request, `${base}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` }
      }, options.timeoutMs);
      const body = await readMetaJson(response);
      if (!response.ok || body.success !== true) {
        throw metaError(response, body, "META_WEBHOOK_UNSUBSCRIBE_FAILED");
      }
    },

    async verifyApprovedTemplate(
      accessToken: string,
      wabaId: string,
      templateName: string,
      languageCode: string
    ): Promise<{ name: string; category: string; languageCode: string }> {
      assertProviderId(wabaId, "WABA");
      if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(templateName) || !/^[A-Za-z0-9_-]{2,35}$/u.test(languageCode)) {
        throw new MetaGraphError("META_TEMPLATE_IDENTIFIER_INVALID", 400, false);
      }
      const url = new URL(`${base}/${encodeURIComponent(wabaId)}/message_templates`);
      url.searchParams.set("name", templateName);
      url.searchParams.set("fields", "name,status,category,language");
      const response = await boundedFetch(request, url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` }
      }, options.timeoutMs);
      const body = await readMetaJson(response);
      if (!response.ok) throw metaError(response, body, "META_TEMPLATE_LOOKUP_FAILED");
      const templates = Array.isArray(body.data) ? body.data.filter(isRecord) : [];
      const template = templates.find((candidate) =>
        readString(candidate.name) === templateName && readString(candidate.language) === languageCode
      );
      if (!template || readString(template.status) !== "APPROVED") {
        throw new MetaGraphError("META_TEMPLATE_NOT_APPROVED", 409, false);
      }
      const category = readString(template.category);
      if (!category) throw new MetaGraphError("META_TEMPLATE_CATEGORY_MISSING", 502, true);
      return { name: templateName, category, languageCode };
    },

    async retrieveMediaMetadata(
      accessToken: string,
      mediaId: string,
      phoneNumberId: string
    ): Promise<MetaMediaMetadata> {
      assertProviderId(mediaId, "media");
      assertProviderId(phoneNumberId, "phone number");
      const url = new URL(`${base}/${encodeURIComponent(mediaId)}`);
      url.searchParams.set("phone_number_id", phoneNumberId);
      const response = await boundedFetch(request, url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` }
      }, options.timeoutMs);
      const body = await readMetaJson(response);
      const mediaUrl = readString(body.url);
      const mimeType = readString(body.mime_type);
      if (!response.ok || !mediaUrl || !mimeType) {
        throw metaError(response, body, "META_MEDIA_LOOKUP_FAILED");
      }
      assertMetaMediaUrl(mediaUrl);
      const sha256 = readString(body.sha256);
      const fileSize = readPositiveNumber(body.file_size);
      return {
        url: mediaUrl,
        mimeType,
        ...(sha256 ? { sha256 } : {}),
        ...(fileSize ? { fileSize } : {})
      };
    },

    async downloadMedia(
      accessToken: string,
      mediaUrl: string,
      maximumBytes: number
    ): Promise<{ bytes: Uint8Array; contentType?: string }> {
      assertMetaMediaUrl(mediaUrl);
      if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 100 * 1024 * 1024) {
        throw new Error("Invalid media download limit");
      }
      let currentUrl = mediaUrl;
      for (let hop = 0; hop <= 3; hop += 1) {
        const response = await boundedFetch(request, currentUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
          redirect: "manual"
        }, options.timeoutMs);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || hop === 3) {
            throw new MetaGraphError("META_MEDIA_REDIRECT_INVALID", 502, false);
          }
          const nextUrl = new URL(location, currentUrl).toString();
          assertMetaMediaUrl(nextUrl);
          currentUrl = nextUrl;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new MetaGraphError("META_MEDIA_DOWNLOAD_FAILED", response.status || 502, response.status === 429 || response.status >= 500);
        }
        const bytes = await readBoundedBytes(response, maximumBytes);
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
        return { bytes, ...(contentType ? { contentType } : {}) };
      }
      throw new MetaGraphError("META_MEDIA_REDIRECT_INVALID", 502, false);
    },

    async listFlows(accessToken: string, wabaId: string): Promise<Array<{ id: string; name: string; status: string }>> {
      assertProviderId(wabaId, "WABA");
      const url = new URL(`${base}/${encodeURIComponent(wabaId)}/flows`);
      url.searchParams.set("fields", "id,name,status");
      url.searchParams.set("limit", "100");
      const response = await boundedFetch(request, url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` }
      }, options.timeoutMs);
      const body = await readMetaJson(response);
      if (!response.ok) throw metaError(response, body, "META_FLOW_LOOKUP_FAILED");
      const rows = Array.isArray(body.data) ? body.data.filter(isRecord) : [];
      return rows.flatMap(row => {
        const id = readString(row.id), name = readString(row.name), status = readString(row.status);
        return id && name && status ? [{ id, name, status }] : [];
      });
    },

    async createFlow(accessToken: string, wabaId: string, name: string, category: string): Promise<string> {
      assertProviderId(wabaId, "WABA");
      const form = new FormData();
      form.set("name", name);
      form.set("categories", JSON.stringify([category]));
      const response = await boundedFetch(request, `${base}/${wabaId}/flows`, {
        method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form
      }, options.timeoutMs);
      const body = await readMetaJson(response);
      if (!response.ok) throw metaError(response, body, "META_FLOW_CREATE_FAILED");
      const id = readString(body.id);
      if (!id || !/^\d{3,32}$/u.test(id)) throw new MetaGraphError("META_FLOW_CREATE_RESPONSE_INVALID", 502, false);
      return id;
    },

    async uploadFlowJson(accessToken: string, flowId: string, flowJson: string): Promise<Array<{ code: string }>> {
      assertProviderId(flowId, "Flow");
      const form = new FormData();
      form.set("file", new Blob([flowJson], { type: "application/json" }), "flow.json");
      form.set("name", "flow.json");
      form.set("asset_type", "FLOW_JSON");
      const response = await boundedFetch(request, `${base}/${flowId}/assets`, {
        method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form
      }, options.timeoutMs);
      const body = await readMetaJson(response);
      if (!response.ok) throw metaError(response, body, "META_FLOW_UPLOAD_FAILED");
      return (Array.isArray(body.validation_errors) ? body.validation_errors : []).filter(isRecord).map(error => ({
        code: readString(error.error) ?? "META_FLOW_VALIDATION_ERROR"
      }));
    },

    async publishFlow(accessToken: string, flowId: string): Promise<void> {
      assertProviderId(flowId, "Flow");
      const response = await boundedFetch(request, `${base}/${flowId}/publish`, {
        method: "POST", headers: { Authorization: `Bearer ${accessToken}` }
      }, options.timeoutMs);
      const body = await readMetaJson(response);
      if (!response.ok || body.success !== true) throw metaError(response, body, "META_FLOW_PUBLISH_FAILED");
    },

    async sendText(
      accessToken: string,
      phoneNumberId: string,
      recipient: string,
      text: string
    ): Promise<MetaProviderResult> {
      return sendMessage(accessToken, phoneNumberId, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: { body: text, preview_url: false }
      });
    },

    async sendTemplate(
      accessToken: string,
      phoneNumberId: string,
      recipient: string,
      templateName: string,
      languageCode: string,
      variables: readonly string[]
    ): Promise<MetaProviderResult> {
      return sendMessage(accessToken, phoneNumberId, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
          ...(variables.length > 0 ? {
            components: [{
              type: "body",
              parameters: variables.map((text) => ({ type: "text", text }))
            }]
          } : {})
        }
      });
    }
  };

  async function sendMessage(
    accessToken: string,
    phoneNumberId: string,
    body: Record<string, unknown>
  ): Promise<MetaProviderResult> {
    assertProviderId(phoneNumberId, "phone number");
    const response = await boundedFetch(request, `${base}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }, options.timeoutMs);
    const payload = await readMetaJson(response);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const messageRef = isRecord(messages[0]) ? readString(messages[0].id) : null;
    if (!response.ok || !messageRef) throw metaError(response, payload, "META_MESSAGE_DISPATCH_FAILED");
    return { messageRef, status: "accepted" };
  }
}

async function readBoundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel();
    throw new MetaGraphError("META_MEDIA_TOO_LARGE", 413, false);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new MetaGraphError("META_MEDIA_TOO_LARGE", 413, false);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function assertMetaMediaUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MetaGraphError("META_MEDIA_URL_INVALID", 502, false);
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = hostname === "lookaside.fbsbx.com" || hostname.endsWith(".fbcdn.net");
  if (url.protocol !== "https:" || !allowed || url.username || url.password) {
    throw new MetaGraphError("META_MEDIA_URL_INVALID", 502, false);
  }
}

async function boundedFetch(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = 10_000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new MetaGraphError("META_REQUEST_TIMEOUT", 504, true);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readMetaJson(response: Response, maximumBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel();
    throw new MetaGraphError("META_RESPONSE_TOO_LARGE", 502, true);
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new MetaGraphError("META_RESPONSE_TOO_LARGE", 502, true);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(merged));
    return isRecord(value) ? value : {};
  } catch {
    throw new MetaGraphError("META_INVALID_RESPONSE", 502, true);
  }
}

function metaError(response: Response, body: Record<string, unknown>, fallback: string): MetaGraphError {
  const error = isRecord(body.error) ? body.error : null;
  const providerCode = typeof error?.code === "number" ? String(error.code) : null;
  const code = providerCode ? `${fallback}_${providerCode}` : fallback;
  return new MetaGraphError(code, response.status || 502, response.status === 429 || response.status >= 500);
}

function assertProviderId(value: string, label: string): void {
  if (!/^\d{3,32}$/u.test(value)) throw new Error(`Invalid Meta ${label} identifier`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
