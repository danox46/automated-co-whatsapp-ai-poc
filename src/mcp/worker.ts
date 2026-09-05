import { createProtectedWhatsAppMcpHandler } from "./server.js";

const RESOURCE = "https://auth.automatedandco.danienremoto.com";

// Production deliberately remains deny-all until the OAuth broker supplies an
// audience-bound verifier. Deploying this file without that verifier cannot
// expose WhatsApp data or tools.
const handler = createProtectedWhatsAppMcpHandler({
  resource: RESOURCE,
  authorizationServer: RESOURCE
});

export default {
  fetch(request: Request) {
    return handler.fetch(request);
  }
};
