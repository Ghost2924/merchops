// Shared TypeScript types for the Teapplix Analytics Dashboard

export interface SkuRecord {
  sku: string;           // SKU identifier / name
  quantitySold: number;  // Units sold on this day
  totalRevenue: number;  // Revenue from this SKU on this day (USD)
  unitPrice: number;     // Average unit price (totalRevenue / quantitySold)
}

export interface DailySummary {
  date: string;          // ISO date string "YYYY-MM-DD"
  orderCount: number;    // Total orders for the day
  totalRevenue: number;  // Sum of all order revenue (USD)
  aov: number;           // Average order value = totalRevenue / orderCount
  skus: SkuRecord[];     // Per-SKU breakdown
  cogs?: number;         // Total cost of goods sold (USD)
}

export interface OrderRecord {
  orderDate: string;      // "YYYY-MM-DD"
  paymentDate: string;    // "YYYY-MM-DD"
  sku: string;
  quantity: number;
  unitPrice: number;
  totalRevenue: number;
}

export type TrendIndicator = 'up' | 'down' | 'stable';

export interface VolatilityEntry {
  sku: string;
  velocityCurrent: number;   // units/day over last 7 days
  velocityPrior: number;     // units/day over prior 7 days
  trend: TrendIndicator;
  daysOfSupply: number | null; // qty_available / velocityCurrent; null if no inventory data
}
