export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const migrations: Migration[] = [
  {
    version: 1,
    name: "operator inbox foundation",
    sql: `
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        wa_id TEXT,
        public_profile_name TEXT,
        local_alias TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot', 'human')),
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_inbound_at TEXT,
        last_message_at TEXT,
        automation_disclosure_sent INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        provider_sid TEXT UNIQUE,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'system')),
        author TEXT NOT NULL CHECK (author IN ('customer', 'bot', 'operator', 'system')),
        body TEXT NOT NULL DEFAULT '',
        provider_status TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS messages_conversation_created
        ON messages(conversation_id, created_at, id);

      CREATE TABLE IF NOT EXISTS received_media (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        provider_url TEXT NOT NULL,
        content_type TEXT NOT NULL,
        byte_size INTEGER,
        original_filename TEXT,
        local_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'rejected', 'failed')),
        error_message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS received_media_message
        ON received_media(message_id);

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS audit_events_created
        ON audit_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS runtime_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  }
];
