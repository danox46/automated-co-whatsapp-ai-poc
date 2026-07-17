export type ExtractedFields = {
  productKeywords: string[];
  requestedQuantity?: number;
  size?: string;
  department?: string;
  city?: string;
};

const productKeywordGroups = [
  {
    canonical: "diablitos",
    terms: ["diablitos", "underwood", "jamon endiablado", "jamón endiablado"]
  },
  { canonical: "riko malt", terms: ["riko malt", "rikomalt", "maltin", "malta", "malt"] },
  {
    canonical: "golden manzanita",
    terms: ["golden", "manzanita", "golden manzanita", "refresco de manzana"]
  },
  { canonical: "canelitas", terms: ["canelitas", "canelita", "galletas marinela"] },
  { canonical: "sopa maggi", terms: ["sopa maggi", "maggi", "sopa de pollo", "sopa con fideos"] }
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
const departmentKeywords = new Map([
  ["bogota", "bogota"],
  ["cundinamarca", "cundinamarca"],
  ["antioquia", "antioquia"],
  ["valle del cauca", "valle del cauca"],
  ["valle", "valle del cauca"],
  ["atlantico", "atlantico"],
  ["atlántico", "atlantico"],
  ["bolivar", "bolivar"],
  ["bolívar", "bolivar"],
  ["cordoba", "cordoba"],
  ["córdoba", "cordoba"]
]);

const cityKeywords = new Map([
  ["bogota", { city: "bogota", department: "bogota" }],
  ["bogotá", { city: "bogota", department: "bogota" }],
  ["chia", { city: "chia", department: "cundinamarca" }],
  ["chía", { city: "chia", department: "cundinamarca" }],
  ["medellin", { city: "medellin", department: "antioquia" }],
  ["medellín", { city: "medellin", department: "antioquia" }],
  ["cali", { city: "cali", department: "valle del cauca" }],
  ["barranquilla", { city: "barranquilla", department: "atlantico" }],
  ["cartagena", { city: "cartagena", department: "bolivar" }],
  ["planeta rica", { city: "planeta rica", department: "cordoba" }]
]);

export function extractFields(text: string): ExtractedFields {
  const normalized = normalizeText(text);
  const productKeywords = productKeywordGroups
    .filter((group) => group.terms.some((keyword) => normalized.includes(keyword)))
    .map((group) => group.canonical);
  const location = extractLocation(normalized);

  return {
    productKeywords,
    requestedQuantity: extractRequestedQuantity(normalized),
    size: extractSize(normalized),
    department: location.department,
    city: location.city
  };
}

function extractSize(text: string) {
  const packSize = text.match(/\bpack\s*x?\s*(\d{1,2})\b/);
  if (packSize?.[1]) {
    return `pack x${packSize[1]}`;
  }

  const unidadesPackSize = text.match(/\bx\s*(\d{1,2})\s*(unidades|unidad|unds|und)\b/);
  if (unidadesPackSize?.[1]) {
    return `pack x${unidadesPackSize[1]}`;
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
  const quantityNouns =
    "unidades|unidad|units|unit|items|productos|products|frascos|frasco|botellas|botella|paquetes|paquete|latas|lata|sobres|sobre|diablitos|maltas|malta|galletas|galleta|sopas|sopa";
  const quantityPatterns = [
    new RegExp(`\\b(\\d{1,2})\\s*(${quantityNouns})\\b`),
    new RegExp(
      `\\b(uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|one|two|three|four|five|six|seven|eight|nine|ten)\\s*(${quantityNouns})\\b`
    )
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

function extractLocation(text: string) {
  let department: string | undefined;
  let city: string | undefined;

  for (const [keyword, value] of departmentKeywords.entries()) {
    if (text.includes(normalizeText(keyword))) {
      department = value;
      break;
    }
  }

  for (const [keyword, value] of cityKeywords.entries()) {
    if (text.includes(normalizeText(keyword))) {
      city = value.city;
      department = department ?? value.department;
      break;
    }
  }

  return { department, city };
}
