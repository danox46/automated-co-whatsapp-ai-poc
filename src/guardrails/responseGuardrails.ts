export type GuardrailResult = {
  allowed: boolean;
  reasons: string[];
  responseText: string;
};

export function applyResponseGuardrails(responseText: string): GuardrailResult {
  const trimmed = responseText.trim();

  if (!trimmed) {
    return {
      allowed: true,
      reasons: ["Fallback response applied."],
      responseText: "Me ayudas con un poco mas de detalle para entender como ayudarte?"
    };
  }

  // TODO: Expand with channel limits and policy checks as the mocked pipeline matures.
  return {
    allowed: true,
    reasons: [],
    responseText: trimmed
  };
}
