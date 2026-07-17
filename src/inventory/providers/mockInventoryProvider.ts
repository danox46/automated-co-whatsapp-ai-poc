import type {
  InventoryAvailability,
  InventoryCatalogProduct,
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
    id: "prod_diablitos_underwood",
    name: "Diablitos Underwood",
    keywords: ["diablitos", "underwood", "jamon endiablado", "jamón endiablado"],
    productUrl: "https://elportalvenezolano.com/products/diablitos",
    deliveryNotes: "Snapshot copiado del catalogo publico. Disponibilidad real debe venir luego por API.",
    variants: [
      {
        id: "diablitos_54g_x24",
        label: "54g x 24 unidades",
        size: "54g",
        quantityAvailable: 8,
        upsell: "Tambien aparece disponible la caja de 54g x 48 unidades si necesitas volumen."
      },
      {
        id: "diablitos_54g_x48",
        label: "54g x 48 unidades",
        size: "pack x48",
        quantityAvailable: 3
      },
      {
        id: "diablitos_115g_x12",
        label: "115g x 12 unidades",
        size: "115g",
        quantityAvailable: 4
      },
      {
        id: "diablitos_115g_x24",
        label: "115g x 24 unidades",
        size: "pack x24",
        quantityAvailable: 2
      }
    ]
  },
  {
    id: "prod_riko_malt",
    name: "Riko Malt 500Ml Venezuela",
    keywords: ["riko malt", "rikomalt", "maltin", "malta", "malt"],
    productUrl: "https://elportalvenezolano.com/products/riko-malt-500ml-venezuela",
    deliveryNotes: "Bebida venezolana. Snapshot copiado del catalogo publico.",
    variants: [
      {
        id: "riko_malt_500ml",
        label: "botella 500ml",
        size: "500ml",
        quantityAvailable: 10,
        upsell: "Tambien aparece la presentacion x 3 unidades."
      },
      {
        id: "riko_malt_500ml_x3",
        label: "500ml x 3 unidades",
        size: "pack x3",
        quantityAvailable: 5,
        substituteFor: { size: "500ml", unitsNeeded: 1 }
      }
    ]
  },
  {
    id: "prod_golden_manzanita",
    name: "Golden Manzanita lata 355 Ml Venezuela",
    keywords: ["golden", "manzanita", "golden manzanita", "refresco de manzana"],
    productUrl: "https://elportalvenezolano.com/products/golden-manzanita-botella-350-ml-venezuela-copia",
    deliveryNotes: "Refresco en lata. Snapshot copiado del catalogo publico.",
    variants: [
      {
        id: "golden_355ml",
        label: "lata 355ml",
        size: "355ml",
        quantityAvailable: 12,
        upsell: "Tambien aparece disponible el pack x 6 unidades."
      },
      {
        id: "golden_355ml_x6",
        label: "lata 355ml x 6 unidades",
        size: "pack x6",
        quantityAvailable: 4,
        substituteFor: { size: "355ml", unitsNeeded: 1 }
      }
    ]
  },
  {
    id: "prod_canelitas",
    name: "Canelitas Marinela",
    keywords: ["canelitas", "canelita", "galletas de canela", "galletas marinela"],
    productUrl: "https://elportalvenezolano.com/products/canelitas-marinela-galletas-venezolanas",
    deliveryNotes: "Galletas venezolanas. El pack x3 aparece no disponible en el snapshot publico.",
    variants: [
      {
        id: "canelitas_individual",
        label: "paquete individual",
        size: "individual",
        quantityAvailable: 9,
        substituteFor: { size: "pack x3", unitsNeeded: 3 }
      },
      {
        id: "canelitas_x3",
        label: "pack x 3 unidades",
        size: "pack x3",
        quantityAvailable: 0
      }
    ]
  },
  {
    id: "prod_sopa_maggi",
    name: "Sopa de Pollo con Fideos Maggi 62g Venezuela",
    keywords: ["sopa maggi", "maggi", "sopa de pollo", "sopa con fideos"],
    productUrl: "https://elportalvenezolano.com/products/sopa-maggi-62gr-venezuela",
    deliveryNotes: "Producto liviano. Snapshot copiado del catalogo publico.",
    variants: [
      {
        id: "sopa_maggi_62g",
        label: "sobre 62g",
        size: "62g",
        quantityAvailable: 15,
        upsell: "Tambien aparece disponible el pack x 3 unidades."
      },
      {
        id: "sopa_maggi_62g_x3",
        label: "62g x 3 unidades",
        size: "pack x3",
        quantityAvailable: 5,
        substituteFor: { size: "62g", unitsNeeded: 1 }
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

  async listCatalog(): Promise<InventoryCatalogProduct[]> {
    return mockProducts.map((product) => ({
      id: product.id,
      name: product.name,
      keywords: product.keywords,
      productUrl: product.productUrl,
      notes: product.deliveryNotes,
      variants: product.variants.map((variant) => ({
        id: variant.id,
        label: variant.label,
        size: variant.size,
        available: variant.quantityAvailable > 0,
        quantityAvailable: variant.quantityAvailable,
        advisoryText: variant.upsell
      }))
    }));
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
    .replace(/^paquete individual/, "paquetes individuales")
    .replace(/^lata /, "latas ")
    .replace(/^paquete /, "paquetes ")
    .replace(/^sobre /, "sobres ");
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
