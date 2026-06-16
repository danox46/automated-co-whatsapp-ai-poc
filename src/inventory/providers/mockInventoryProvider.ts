import type {
  InventoryAvailability,
  InventoryProvider,
  InventoryQuery
} from "../InventoryProvider.js";

type MockVariant = {
  id: string;
  label: string;
  size?: string;
  quantityAvailable: number;
  substituteFor?: {
    size: string;
    unitsNeeded: number;
  };
  upsell?: string;
};

type MockProduct = {
  id: string;
  name: string;
  keywords: string[];
  productUrl: string;
  deliveryNotes?: string;
  variants: MockVariant[];
};

const mockProducts: MockProduct[] = [
  {
    id: "prod_mayonesa",
    name: "Mayonesa",
    keywords: ["mayonesa", "mayo", "mayonnaise"],
    productUrl: "https://automated.co/mock/mayonesa",
    deliveryNotes: "Producto refrigerado despues de abrir. Entrega estandar aplica.",
    variants: [
      {
        id: "mayo_grande_900g",
        label: "frasco grande 900g",
        size: "grande",
        quantityAvailable: 0
      },
      {
        id: "mayo_mediana_450g",
        label: "frasco mediano 450g",
        size: "mediana",
        quantityAvailable: 12,
        substituteFor: { size: "grande", unitsNeeded: 2 },
        upsell: "Tambien tenemos salsa de tomate mediana para completar mercado."
      },
      {
        id: "mayo_pequena_220g",
        label: "frasco pequeno 220g",
        size: "pequena",
        quantityAvailable: 20,
        substituteFor: { size: "mediana", unitsNeeded: 2 }
      }
    ]
  },
  {
    id: "prod_arroz",
    name: "Arroz",
    keywords: ["arroz", "rice"],
    productUrl: "https://automated.co/mock/arroz",
    deliveryNotes: "Producto pesado; el tiempo puede variar segun zona.",
    variants: [
      {
        id: "arroz_5kg",
        label: "bolsa 5kg",
        size: "5kg",
        quantityAvailable: 4,
        upsell: "Si es para la semana, tambien tenemos frijol rojo 1kg."
      },
      {
        id: "arroz_1kg",
        label: "bolsa 1kg",
        size: "1kg",
        quantityAvailable: 16,
        substituteFor: { size: "5kg", unitsNeeded: 5 }
      }
    ]
  },
  {
    id: "prod_leche",
    name: "Leche entera",
    keywords: ["leche", "milk"],
    productUrl: "https://automated.co/mock/leche-entera",
    deliveryNotes: "Producto de alta rotacion. Disponibilidad puede cambiar rapido.",
    variants: [
      {
        id: "leche_familiar_6x1l",
        label: "six pack familiar 6 x 1L",
        size: "familiar",
        quantityAvailable: 2
      },
      {
        id: "leche_1l",
        label: "botella 1L",
        size: "1l",
        quantityAvailable: 18,
        substituteFor: { size: "familiar", unitsNeeded: 6 }
      }
    ]
  },
  {
    id: "prod_atun",
    name: "Atun en lata",
    keywords: ["atun", "atún", "tuna"],
    productUrl: "https://automated.co/mock/atun-en-lata",
    deliveryNotes: "Buen candidato para compras por volumen.",
    variants: [
      {
        id: "atun_pack_6",
        label: "pack x6 latas",
        size: "pack x6",
        quantityAvailable: 0
      },
      {
        id: "atun_lata",
        label: "lata individual",
        size: "individual",
        quantityAvailable: 30,
        substituteFor: { size: "pack x6", unitsNeeded: 6 }
      }
    ]
  }
];

export class MockInventoryProvider implements InventoryProvider {
  async findAvailability(query: InventoryQuery): Promise<InventoryAvailability[]> {
    const productSearchText =
      query.productKeywords && query.productKeywords.length > 0
        ? normalizeText(query.productKeywords.join(" "))
        : normalizeText(query.searchText);

    const matchedProducts = mockProducts.filter((product) =>
      product.keywords.some((keyword) => productSearchText.includes(normalizeText(keyword)))
    );

    return matchedProducts.flatMap((product) => buildProductResults(product, query));
  }
}

function buildProductResults(product: MockProduct, query: InventoryQuery): InventoryAvailability[] {
  const requestedSize = query.size ? normalizeText(query.size) : undefined;
  const requestedQuantity = query.requestedQuantity ?? 1;
  const requestedVariants = product.variants.filter((variant) =>
    requestedSize ? normalizeText(variant.size ?? variant.label) === requestedSize : true
  );
  const selectedRequestedVariants = requestedVariants.length > 0 ? requestedVariants : product.variants;
  const requestedResults = selectedRequestedVariants.map((variant) =>
    toAvailability(product, variant, "requested", true)
  );

  if (!requestedSize) {
    return requestedResults;
  }

  const hasEnoughRequested = requestedResults.some(
    (match) => (match.quantityAvailable ?? 0) >= requestedQuantity
  );
  if (hasEnoughRequested) {
    return [
      ...requestedResults,
      ...findUpsells(product, selectedRequestedVariants).map((variant) =>
        toAvailability(product, variant, "upsell", false, variant.upsell)
      )
    ];
  }

  const alternatives = product.variants
    .filter((variant) => {
      const substitute = variant.substituteFor;
      if (!substitute || normalizeText(substitute.size) !== requestedSize) {
        return false;
      }

      return variant.quantityAvailable >= substitute.unitsNeeded * requestedQuantity;
    })
    .map((variant) =>
      toAvailability(
        product,
        variant,
        "alternative",
        false,
        buildAlternativeText(variant, requestedSize, requestedQuantity)
      )
    );

  return [...requestedResults, ...alternatives];
}

function findUpsells(product: MockProduct, selectedVariants: MockVariant[]) {
  const selectedIds = new Set(selectedVariants.map((variant) => variant.id));
  return product.variants.filter(
    (variant) => !selectedIds.has(variant.id) && variant.quantityAvailable > 0 && variant.upsell
  );
}

function toAvailability(
  product: MockProduct,
  variant: MockVariant,
  advisoryRole: InventoryAvailability["advisoryRole"],
  requestedMatch: boolean,
  advisoryText?: string
): InventoryAvailability {
  return {
    productId: product.id,
    productName: product.name,
    variantLabel: variant.label,
    available: variant.quantityAvailable > 0,
    quantityAvailable: variant.quantityAvailable,
    requestedMatch,
    advisoryRole,
    advisoryText,
    productUrl: product.productUrl,
    notes: product.deliveryNotes
  };
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function buildAlternativeText(variant: MockVariant, requestedSize: string, requestedQuantity: number) {
  const unitsNeeded = variant.substituteFor?.unitsNeeded ?? 1;
  const alternativeQuantity = unitsNeeded * requestedQuantity;
  const requestedText =
    requestedQuantity > 1 ? `${requestedQuantity} ${pluralizeSize(requestedSize)}` : `1 ${requestedSize}`;

  return `Como alternativa, puedes pedir ${alternativeQuantity} ${pluralizeLabel(variant.label)} para cubrir ${requestedText}.`;
}

function pluralizeLabel(label: string) {
  return label
    .replace(/^frasco mediano/, "frascos medianos")
    .replace(/^frasco pequeno/, "frascos pequenos")
    .replace(/^bolsa /, "bolsas ")
    .replace(/^botella /, "botellas ")
    .replace(/^lata individual/, "latas individuales");
}

function pluralizeSize(size: string) {
  if (size === "grande") {
    return "grandes";
  }

  if (size === "mediana") {
    return "medianas";
  }

  return size;
}
