export type ExtractedFields = {
  productKeywords: string[];
  requestedQuantity?: number;
  size?: string;
  city?: string;
};

const productKeywordGroups = [
  { canonical: "mayonesa", terms: ["mayonesa", "mayonesas", "mayo", "mayonnaise"] },
  { canonical: "arroz", terms: ["arroz", "rice"] },
  { canonical: "leche", terms: ["leche", "milk"] },
  { canonical: "atun", terms: ["atun", "atún", "tuna"] },
  { canonical: "pasta", terms: ["pasta", "spaghetti", "espagueti"] }
];

const sizeKeywords = new Map([
  ["grande", "grande"],
  ["large", "grande"],
  ["mediana", "mediana"],
  ["mediano", "mediana"],
  ["medium", "mediana"],
  ["pequena", "pequena"],
  ["pequeno", "pequena"],
  ["pequeña", "pequena"],
  ["pequeño", "pequena"],
  ["small", "pequena"],
  ["familiar", "familiar"],
  ["personal", "personal"]
]);
const cityKeywords = ["bogota", "medellin", "cali", "barranquilla", "cartagena"];

export function extractFields(text: string): ExtractedFields {
  const normalized = normalizeText(text);
  const productKeywords = productKeywordGroups
    .filter((group) => group.terms.some((keyword) => normalized.includes(keyword)))
    .map((group) => group.canonical);

  return {
    productKeywords,
    requestedQuantity: extractRequestedQuantity(normalized),
    size: extractSize(normalized),
    city: cityKeywords.find((city) => normalized.includes(city))
  };
}

function extractSize(text: string) {
  const packSize = text.match(/\bpack\s*x?\s*(\d{1,2})\b/);
  if (packSize?.[1]) {
    return `pack x${packSize[1]}`;
  }

  for (const [keyword, canonical] of sizeKeywords.entries()) {
    if (text.includes(keyword)) {
      return canonical;
    }
  }

  const weightOrVolume = text.match(/\b(\d+(?:[.,]\d+)?)\s*(kg|g|gr|gramos|l|lt|litro|litros|ml)\b/);
  if (weightOrVolume?.[1] && weightOrVolume[2]) {
    return `${weightOrVolume[1].replace(",", ".")}${weightOrVolume[2]}`;
  }

  return undefined;
}

function extractRequestedQuantity(text: string) {
  const quantityPatterns = [
    /\b(\d{1,2})\s*(unidades|unidad|units|unit|items|productos|products|frascos|frasco|botellas|botella|paquetes|paquete|latas|lata|mayonesas|mayonesa|arroces|arroz|leches|leche|atunes|atun|atún)\b/,
    /\b(uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|one|two|three|four|five|six|seven|eight|nine|ten)\s*(unidades|unidad|units|unit|items|productos|products|frascos|frasco|botellas|botella|paquetes|paquete|latas|lata|mayonesas|mayonesa|arroces|arroz|leches|leche|atunes|atun|atún)\b/
  ];

  for (const pattern of quantityPatterns) {
    const match = text.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const numericValue = Number(match[1]);
    if (Number.isInteger(numericValue) && numericValue > 0) {
      return numericValue;
    }

    return numberWords.get(match[1]);
  }

  return undefined;
}

const numberWords = new Map([
  ["uno", 1],
  ["una", 1],
  ["dos", 2],
  ["tres", 3],
  ["cuatro", 4],
  ["cinco", 5],
  ["seis", 6],
  ["siete", 7],
  ["ocho", 8],
  ["nueve", 9],
  ["diez", 10],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10]
]);

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
