import type { AppConfig } from "../config/env.js";
import type { InventoryProvider } from "./InventoryProvider.js";
import { MockInventoryProvider } from "./providers/mockInventoryProvider.js";
import { ShopifyInventoryProviderPlaceholder } from "./providers/shopifyProvider.placeholder.js";

export function createInventoryProvider(config: AppConfig): InventoryProvider {
  if (config.inventory.provider === "shopify_placeholder") {
    return new ShopifyInventoryProviderPlaceholder();
  }

  return new MockInventoryProvider();
}
