import type { NextFunction, Request, Response } from "express";
import twilio from "twilio";

export type TwilioSignatureConfig = {
  authToken?: string;
  publicUrl?: string;
};

export function createTwilioSignatureMiddleware(
  config: TwilioSignatureConfig,
  validate: typeof twilio.validateRequest = twilio.validateRequest
) {
  return function validateTwilioSignature(req: Request, res: Response, next: NextFunction) {
    if (!config.authToken) {
      res.status(503).json({ error: "Twilio webhook is not configured." });
      return;
    }
    const signature = req.header("x-twilio-signature") ?? "";
    const url = resolveWebhookUrl(req, config.publicUrl);
    if (!validate(config.authToken, signature, url, req.body as Record<string, string>)) {
      res.status(403).send("Forbidden");
      return;
    }
    next();
  };
}

export function resolveWebhookUrl(req: Request, configuredPublicUrl?: string) {
  if (configuredPublicUrl) {
    const configured = new URL(configuredPublicUrl);
    if (configured.pathname !== "/" && req.originalUrl.endsWith(configured.pathname)) {
      return configured.toString();
    }
    return new URL(req.originalUrl, configured.origin).toString();
  }
  const forwardedProto = req.header("x-forwarded-proto")?.split(",", 1)[0].trim();
  const protocol = forwardedProto || req.protocol;
  return `${protocol}://${req.get("host")}${req.originalUrl}`;
}
