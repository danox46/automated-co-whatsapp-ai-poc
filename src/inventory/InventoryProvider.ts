export type InventoryQuery = {
  searchText: string;
  productKeywords?: string[];
  requestedQuantity?: number;
  size?: string;
};

export type InventoryAvailability = {
  productId: string;
  productName: string;
  variantLabel?: string;
  available: boolean | "unknown";
  quantityAvailable?: number;
  requestedMatch: boolean;
  advisoryRole: "requested" | "alternative" | "upsell";
  advisoryText?: string;
  productUrl: string;
  notes?: string;
};

export type InventoryCatalogVariant = {
  id: string;
  label: string;
  size?: string;
  available: boolean | "unknown";
  quantityAvailable?: number;
  advisoryText?: string;
};

export type InventoryCatalogProduct = {
  id: string;
  name: string;
  keywords: string[];
  productUrl: string;
  notes?: string;
  variants: InventoryCatalogVariant[];
};

export interface InventoryProvider {
  findAvailability(query: InventoryQuery): Promise<InventoryAvailability[]>;
  listCatalog(): Promise<InventoryCatalogProduct[]>;
}
