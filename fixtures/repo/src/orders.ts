export type Order = { id: string; status: "pending" | "fulfilled" };

const ORDERS = new Map<string, Order>();
const PROCESSED = new Set<string>();

export function getOrder(id: string): Order {
  return ORDERS.get(id) ?? { id, status: "pending" };
}

/** Marks an order fulfilled. NOT idempotent — callers must dedupe. */
export function fulfill(orderId: string): Order {
  const order = { id: orderId, status: "fulfilled" as const };
  ORDERS.set(orderId, order);
  return order;
}

export function alreadyProcessed(deliveryId: string): boolean {
  return PROCESSED.has(deliveryId);
}

export function markProcessed(deliveryId: string): void {
  PROCESSED.add(deliveryId);
}
