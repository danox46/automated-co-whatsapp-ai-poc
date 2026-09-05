export const DEFAULT_CONVERSATION_RETENTION_POLICY = {
  messageRetentionDays: 90,
  inactiveConversationRetentionDays: 365,
  pendingStatusRetentionDays: 7,
  pruneIntervalHours: 24
} as const;

export type ConversationRetentionPolicy = {
  messageRetentionDays: number;
  inactiveConversationRetentionDays: number;
  pendingStatusRetentionDays: number;
  pruneIntervalHours: number;
};

export type ConversationRetentionEnv = {
  CONVERSATION_MESSAGE_RETENTION_DAYS?: string;
  CONVERSATION_INACTIVE_RETENTION_DAYS?: string;
  CONVERSATION_PENDING_STATUS_RETENTION_DAYS?: string;
  CONVERSATION_RETENTION_INTERVAL_HOURS?: string;
};

export function conversationRetentionPolicyFromEnv(
  env: ConversationRetentionEnv
): ConversationRetentionPolicy {
  const policy = {
    messageRetentionDays: integerEnv(
      env.CONVERSATION_MESSAGE_RETENTION_DAYS,
      DEFAULT_CONVERSATION_RETENTION_POLICY.messageRetentionDays,
      "CONVERSATION_MESSAGE_RETENTION_DAYS"
    ),
    inactiveConversationRetentionDays: integerEnv(
      env.CONVERSATION_INACTIVE_RETENTION_DAYS,
      DEFAULT_CONVERSATION_RETENTION_POLICY.inactiveConversationRetentionDays,
      "CONVERSATION_INACTIVE_RETENTION_DAYS"
    ),
    pendingStatusRetentionDays: integerEnv(
      env.CONVERSATION_PENDING_STATUS_RETENTION_DAYS,
      DEFAULT_CONVERSATION_RETENTION_POLICY.pendingStatusRetentionDays,
      "CONVERSATION_PENDING_STATUS_RETENTION_DAYS"
    ),
    pruneIntervalHours: integerEnv(
      env.CONVERSATION_RETENTION_INTERVAL_HOURS,
      DEFAULT_CONVERSATION_RETENTION_POLICY.pruneIntervalHours,
      "CONVERSATION_RETENTION_INTERVAL_HOURS"
    )
  };
  validateConversationRetentionPolicy(policy);
  return policy;
}

export function validateConversationRetentionPolicy(policy: ConversationRetentionPolicy): void {
  const validInteger = (value: number, minimum: number, maximum: number) =>
    Number.isInteger(value) && value >= minimum && value <= maximum;
  if (!validInteger(policy.messageRetentionDays, 1, 365)) {
    throw new Error("Message retention must be an integer from 1 to 365 days");
  }
  if (!validInteger(policy.inactiveConversationRetentionDays, policy.messageRetentionDays, 730)) {
    throw new Error("Inactive conversation retention must be an integer from message retention through 730 days");
  }
  if (!validInteger(policy.pendingStatusRetentionDays, 1, 30)) {
    throw new Error("Pending status retention must be an integer from 1 to 30 days");
  }
  if (!validInteger(policy.pruneIntervalHours, 1, 168)) {
    throw new Error("Retention interval must be an integer from 1 to 168 hours");
  }
}

function integerEnv(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be an integer`);
  return Number(value);
}
