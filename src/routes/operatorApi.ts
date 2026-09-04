import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import { assertWithinRoot, deleteStoredMedia, sanitizeFilename } from "../media/mediaStore.js";
import type { OperatorRuntime } from "../operator/runtime.js";
import { ServiceWindowClosedError, type ConversationSummary, type StoredMessage } from "../persistence/operatorRepository.js";
import { statusCallbackUrl } from "../twilio/webhookHandler.js";

const aliasSchema = z.object({ alias: z.string().trim().max(80).nullable() });
const replySchema = z.object({ body: z.string().trim().min(1).max(1600) });
const modeSchema = z.object({ mode: z.enum(["bot", "human"]) });
const readSchema = z.object({ read: z.boolean() });
const filterSchema = z.enum(["all", "unread", "human"]);

export function createOperatorApiRouter(config: AppConfig, runtime: OperatorRuntime) {
  const router = Router();

  router.get("/conversations", (req, res) => {
    const filter = filterSchema.catch("all").parse(req.query.filter);
    const search = typeof req.query.search === "string" ? req.query.search : "";
    res.json({ conversations: runtime.repository.listConversations(search, filter).map(publicConversation) });
  });

  router.get("/conversations/:id/messages", (req, res) => {
    const conversation = runtime.repository.getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: "Conversación no encontrada." });
    res.json({ conversation: publicConversation(conversation), messages: runtime.repository.getMessages(req.params.id).map(publicMessage) });
  });

  router.patch("/contacts/:id", (req, res) => {
    const parsed = aliasSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "El alias debe tener máximo 80 caracteres." });
    if (!runtime.repository.setAlias(req.params.id, parsed.data.alias)) return res.status(404).json({ error: "Contacto no encontrado." });
    runtime.events.publish({ type: "contact.alias", data: { contactId: req.params.id } });
    res.json({ ok: true });
  });

  router.post("/conversations/:id/replies", async (req, res) => {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "La respuesta debe tener entre 1 y 1.600 caracteres." });
    const conversation = runtime.repository.getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: "Conversación no encontrada." });
    try {
      const outbound = runtime.repository.createOutboundMessage({
        conversationId: conversation.id,
        body: parsed.data.body,
        author: "operator",
        switchToHuman: true
      });
      runtime.events.publish({ type: "conversation.mode", data: { conversationId: conversation.id, mode: "human" } });
      runtime.events.publish({ type: "message.created", data: { conversationId: conversation.id, messageId: outbound.messageId } });
      try {
        const result = await runtime.sendMessage(config.twilio, {
          to: conversation.phone,
          body: parsed.data.body,
          statusCallback: statusCallbackUrl(config.twilio.webhookPublicUrl)
        });
        runtime.repository.attachProviderResult(outbound.messageId, result.sid, result.status);
        runtime.events.publish({ type: "message.status", data: { conversationId: conversation.id, messageId: outbound.messageId, status: result.status } });
        return res.status(201).json({ messageId: outbound.messageId, status: result.status, demo: config.operator.demoMode });
      } catch (error) {
        runtime.repository.markOutboundFailed(outbound.messageId, error);
        runtime.events.publish({ type: "message.status", data: { conversationId: conversation.id, messageId: outbound.messageId, status: "failed" } });
        return res.status(502).json({ error: error instanceof Error ? error.message : String(error), messageId: outbound.messageId });
      }
    } catch (error) {
      if (error instanceof ServiceWindowClosedError) return res.status(409).json({ error: error.message, code: "SERVICE_WINDOW_CLOSED" });
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/conversations/:id/mode", (req, res) => {
    const parsed = modeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Modo inválido." });
    if (!runtime.repository.setMode(req.params.id, parsed.data.mode)) return res.status(404).json({ error: "Conversación no encontrada." });
    if (parsed.data.mode === "bot") runtime.repository.addSystemMessage(req.params.id, "Bot reanudado para los próximos mensajes entrantes");
    runtime.events.publish({ type: "conversation.mode", data: { conversationId: req.params.id, mode: parsed.data.mode } });
    res.json({ ok: true, mode: parsed.data.mode });
  });

  router.post("/conversations/:id/read", (req, res) => {
    const parsed = readSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Estado de lectura inválido." });
    if (!runtime.repository.markRead(req.params.id, parsed.data.read)) return res.status(404).json({ error: "Conversación no encontrada." });
    runtime.events.publish({ type: "conversation.unread", data: { conversationId: req.params.id, read: parsed.data.read } });
    res.json({ ok: true });
  });

  router.delete("/conversations/:id", async (req, res) => {
    const paths = runtime.repository.deleteConversation(req.params.id);
    if (!paths) return res.status(404).json({ error: "Conversación no encontrada." });
    await deleteStoredMedia(paths, config.operator.mediaPath);
    runtime.events.publish({ type: "conversation.deleted", data: { conversationId: req.params.id } });
    res.sendStatus(204);
  });

  router.get("/media/:id", (req, res) => {
    const media = runtime.repository.getMedia(req.params.id);
    if (!media || media.status !== "ready" || !media.localPath) return res.status(404).json({ error: "Archivo no disponible." });
    const root = resolve(config.operator.mediaPath);
    const target = resolve(media.localPath);
    assertWithinRoot(root, target);
    if (!existsSync(target)) return res.status(404).json({ error: "Archivo no disponible." });
    res.type(media.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${sanitizeFilename(media.originalFilename ?? "archivo")}"`);
    res.sendFile(target);
  });

  router.get("/events", (_req, res) => runtime.events.connect(res));

  router.get("/readiness", (_req, res) => {
    res.json({
      database: "ready",
      twilio: config.twilio.accountSid && config.twilio.authToken && config.twilio.whatsappFrom ? "configured" : "not configured",
      tunnel: config.twilio.webhookPublicUrl ? "configured" : "not configured",
      demoMode: config.operator.demoMode,
      operatorHost: config.operatorHost
    });
  });

  return router;
}

export function publicConversation(conversation: ConversationSummary) {
  const { phone: _phone, ...safe } = conversation;
  return { ...safe, maskedPhone: maskPhone(conversation.phone), serviceWindowOpen: isServiceWindowOpen(conversation.serviceWindowClosesAt) };
}

export function publicMessage(message: StoredMessage) {
  return {
    ...message,
    media: message.media.map(({ providerUrl: _providerUrl, localPath: _localPath, ...media }) => ({
      ...media,
      url: media.status === "ready" ? `/api/media/${media.id}` : null
    }))
  };
}

export function maskPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "••••";
  const visible = digits.slice(0, -4);
  const country = visible.slice(0, Math.max(1, visible.length - 6));
  const local = visible.slice(country.length).match(/.{1,3}/g)?.join(" ") ?? "";
  return `+${country} ${local} ****`.replace(/\s+/g, " ").trim();
}

function isServiceWindowOpen(closesAt: string | null) {
  return closesAt ? Date.parse(closesAt) > Date.now() : false;
}
