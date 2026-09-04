import type { Response } from "express";

export type OperatorEvent = {
  type:
    | "conversation.created"
    | "conversation.updated"
    | "message.created"
    | "message.status"
    | "media.ready"
    | "media.failed"
    | "contact.alias"
    | "conversation.unread"
    | "conversation.mode"
    | "conversation.deleted"
    | "settings.loaded"
    | "settings.invalid";
  data: Record<string, unknown>;
  at?: string;
};

export class OperatorEventHub {
  private readonly clients = new Set<Response>();

  connect(response: Response) {
    response.status(200);
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    response.flushHeaders();
    response.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));
  }

  publish(event: OperatorEvent) {
    const payload = JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() });
    for (const client of this.clients) {
      client.write(`event: ${event.type}\ndata: ${payload}\n\n`);
    }
  }

  get clientCount() {
    return this.clients.size;
  }
}
