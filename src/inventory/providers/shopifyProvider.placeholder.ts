import type {
  InventoryAvailability,
  InventoryProvider,
  InventoryQuery
} from "../InventoryProvider.js";

export class ShopifyInventoryProviderPlaceholder implements InventoryProvider {
  async findAvailability(_query: InventoryQuery): Promise<InventoryAvailability[]> {
    // TODO: Connect to existing Shopify access from the environment/plugin.
    // Keep this read-only. Do not scaffold a custom Shopify app or write scopes.
    return [];
  }
}
