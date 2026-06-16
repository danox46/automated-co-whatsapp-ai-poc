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

export interface InventoryProvider {
  findAvailability(query: InventoryQuery): Promise<InventoryAvailability[]>;
}
