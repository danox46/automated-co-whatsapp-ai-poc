export type DeliveryGuidanceRequest = {
  departmentText?: string;
  cityText?: string;
  productText?: string;
};

export type DeliveryGuidance = {
  source: "public_shopify_delivery_calculator";
  sourceUrl: string;
  department?: string;
  city?: string;
  zone?: string;
  priceCop?: number;
  estimatedDelivery?: string;
  summary: string;
  caveats: string[];
  needsDepartment: boolean;
  needsCity: boolean;
};

const DEFAULT_CALCULATOR_URL =
  "https://elportalvenezolano.com/products/diablitos?variant=50232260198676";

type DeliveryRate = {
  city: string;
  fee: number;
  currency: string;
  eta: string;
  methodId?: string;
};

type DeliveryRateTable = Record<string, DeliveryRate[]>;

type DeliveryRateMatch = DeliveryRate & {
  department: string;
};

type DeliveryGuidanceOptions = {
  calculatorUrl?: string;
  now?: () => number;
  fetchHtml?: (url: string) => Promise<string>;
};

const cacheTtlMs = Number(process.env.DELIVERY_CALCULATOR_CACHE_MS ?? 10 * 60 * 1000);

let cachedRateTable:
  | {
      calculatorUrl: string;
      fetchedAt: number;
      rates: DeliveryRateTable;
    }
  | undefined;

export async function getDeliveryGuidance(
  request: DeliveryGuidanceRequest,
  options: DeliveryGuidanceOptions = {}
): Promise<DeliveryGuidance> {
  const calculatorUrl = options.calculatorUrl ?? DEFAULT_CALCULATOR_URL;
  const department = normalizeText(request.departmentText ?? "");
  const city = normalizeText(request.cityText ?? "");

  if (!department && !city) {
    return {
      source: "public_shopify_delivery_calculator",
      sourceUrl: calculatorUrl,
      summary: "Para calcular el domicilio, dime el departamento y la ciudad o municipio.",
      caveats: ["Las fechas son estimadas, no promesas exactas."],
      needsDepartment: true,
      needsCity: true
    };
  }

  if (!department) {
    return {
      source: "public_shopify_delivery_calculator",
      sourceUrl: calculatorUrl,
      city: request.cityText,
      summary: "Para calcular el domicilio, dime tambien el departamento.",
      caveats: ["Las fechas son estimadas, no promesas exactas."],
      needsDepartment: true,
      needsCity: false
    };
  }

  if (!city) {
    return {
      source: "public_shopify_delivery_calculator",
      sourceUrl: calculatorUrl,
      department: request.departmentText,
      summary: "Para calcular el domicilio, dime la ciudad o municipio.",
      caveats: ["Las fechas son estimadas, no promesas exactas."],
      needsDepartment: false,
      needsCity: true
    };
  }

  const rates = await loadDeliveryRates(calculatorUrl, options).catch(() => undefined);

  if (!rates) {
    return {
      source: "public_shopify_delivery_calculator",
      sourceUrl: calculatorUrl,
      department: request.departmentText,
      city: request.cityText,
      summary:
        "No pude consultar el calculador publico de domicilio en este momento. Te paso con el equipo para confirmarlo.",
      caveats: ["La fuente es el calculador publico de la pagina; puede cambiar sin aviso."],
      needsDepartment: false,
      needsCity: false
    };
  }

  const quote = findConfiguredRate(rates, department, city);

  if (!quote) {
    return {
      source: "public_shopify_delivery_calculator",
      sourceUrl: calculatorUrl,
      department: request.departmentText,
      city: request.cityText,
      summary:
        "No encontre una tarifa de domicilio para esa combinacion en el calculador publico. Te paso con el equipo para confirmarlo.",
      caveats: ["La fuente es el calculador publico de la pagina; puede cambiar sin aviso."],
      needsDepartment: false,
      needsCity: false
    };
  }

  return {
    source: "public_shopify_delivery_calculator",
    sourceUrl: calculatorUrl,
    department: quote.department,
    city: quote.city,
    zone: quote.methodId,
    priceCop: quote.fee,
    estimatedDelivery: quote.eta,
    summary: `Para ${formatLocation(quote.city, quote.department)}, el domicilio aparece en ${formatCop(
      quote.fee
    )} y ${formatEtaSummary(quote.eta)}.`,
    caveats: [
      "Es una estimacion del calculador de domicilio, no una promesa exacta.",
      "La fuente es el calculador publico de la pagina; puede cambiar sin aviso."
    ],
    needsDepartment: false,
    needsCity: false
  };
}

export function parseDeliveryRatesFromCalculatorHtml(html: string): DeliveryRateTable {
  const match = html.match(
    /const\s+shippingRatesByDepartment\s*=\s*(\{[\s\S]*?\});\s*const\s+textCollator/
  );

  if (!match?.[1]) {
    throw new Error("Could not find shippingRatesByDepartment in calculator page HTML.");
  }

  return JSON.parse(match[1]) as DeliveryRateTable;
}

export function formatCop(value: number) {
  return `$${value.toLocaleString("es-CO")} COP`;
}

function formatLocation(city: string, department: string) {
  return `${city}, ${department}`;
}

function formatEtaSummary(eta: string) {
  const normalizedEta = eta.trim();
  if (normalizeText(normalizedEta).startsWith("entrega estimada")) {
    return `la ${normalizedEta.toLowerCase()}`;
  }

  return `la entrega estimada es ${normalizedEta.toLowerCase()}`;
}

async function loadDeliveryRates(
  calculatorUrl: string,
  options: DeliveryGuidanceOptions
): Promise<DeliveryRateTable> {
  const now = options.now?.() ?? Date.now();
  if (
    cachedRateTable &&
    cachedRateTable.calculatorUrl === calculatorUrl &&
    now - cachedRateTable.fetchedAt < cacheTtlMs
  ) {
    return cachedRateTable.rates;
  }

  const html = options.fetchHtml ? await options.fetchHtml(calculatorUrl) : await fetchCalculatorHtml(calculatorUrl);
  const rates = parseDeliveryRatesFromCalculatorHtml(html);

  cachedRateTable = {
    calculatorUrl,
    fetchedAt: now,
    rates
  };

  return rates;
}

async function fetchCalculatorHtml(calculatorUrl: string) {
  const response = await fetch(calculatorUrl);
  if (!response.ok) {
    throw new Error(`Delivery calculator fetch failed with ${response.status}`);
  }

  return response.text();
}

function findConfiguredRate(
  rates: DeliveryRateTable,
  departmentText: string,
  cityText: string
): DeliveryRateMatch | undefined {
  const departmentEntry = Object.entries(rates).find(
    ([department]) => normalizeText(department) === departmentText || normalizeText(department).startsWith(departmentText)
  );

  if (!departmentEntry) {
    return undefined;
  }

  const [department, departmentRates] = departmentEntry;
  const rate = departmentRates.find((item) => {
    const normalizedCity = normalizeText(item.city);
    return normalizedCity === cityText || normalizedCity.includes(cityText);
  });

  return rate ? { ...rate, department } : undefined;
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
