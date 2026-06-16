export type DeliveryGuidanceRequest = {
  destinationText?: string;
  productText?: string;
};

export type DeliveryGuidance = {
  destinationType: "bogota" | "national" | "unknown";
  summary: string;
  caveats: string[];
  needsCity: boolean;
};

export async function getDeliveryGuidance(request: DeliveryGuidanceRequest): Promise<DeliveryGuidance> {
  const destination = normalizeText(request.destinationText ?? "");

  if (!destination) {
    return {
      destinationType: "unknown",
      summary: "Para estimar el envio, dime la ciudad de destino.",
      caveats: ["Las fechas son estimadas, no promesas exactas."],
      needsCity: true
    };
  }

  if (destination.includes("bogota")) {
    return {
      destinationType: "bogota",
      summary: "A Bogota el envio suele tardar 1-2 dias habiles.",
      caveats: ["Es una estimacion, no una fecha exacta garantizada."],
      needsCity: false
    };
  }

  return {
    destinationType: "national",
    summary: `A ${request.destinationText} el envio nacional suele tardar 3-5 dias habiles.`,
    caveats: ["Es una estimacion, no una fecha exacta garantizada."],
    needsCity: false
  };
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
