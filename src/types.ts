/**
 * Shared domain types for the Leclerc Drive MCP server.
 *
 * These are the shapes the MCP tools expose to the model. The raw shapes
 * returned by the Leclerc Drive backend are mapped into these in the client
 * layer (see src/leclerc/client.ts) once the API has been reverse-engineered.
 */

export interface Product {
  /** Stable product identifier used by add_to_cart / update_quantity. */
  id: string;
  /** Display label, e.g. "Lait demi-écrémé Bio 1L". */
  label: string;
  /** Brand, e.g. "Marque Repère". Optional — not always present. */
  brand?: string;
  /** Unit price in euros, e.g. 1.29. */
  price: number;
  /** Price per kilo / litre when the site exposes it, e.g. "1,29 €/L". */
  pricePerUnit?: string;
  /** Nutri-Score letter A–E, when available. */
  nutriScore?: string;
  /** Whether the item is currently orderable in the selected store. */
  available: boolean;
  /** Thumbnail image URL, when available. */
  imageUrl?: string;
}

export interface CartItem {
  product: Product;
  quantity: number;
  /** quantity * unit price, in euros. */
  lineTotal: number;
}

export interface Cart {
  items: CartItem[];
  /** Number of distinct lines in the cart. */
  itemCount: number;
  /** Sum of all line totals, in euros. */
  total: number;
  storeId: string;
}

export interface ShoppingList {
  /** Identifier used by get_list (from the detail-liste-{id}.aspx URL). */
  id: string;
  name: string;
  /** Number of products shown on the "Mes listes" page, when present. */
  productCount?: number;
}
