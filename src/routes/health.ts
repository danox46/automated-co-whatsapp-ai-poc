import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "automated-co-whatsapp-legacy-twilio",
    activeProvider: "legacy_twilio",
    defaultProvider: "internal_mcp",
    legacy: true
  });
});
