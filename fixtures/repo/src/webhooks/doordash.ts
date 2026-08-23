import { alreadyProcessed, fulfill, markProcessed } from "../orders.ts";

export function handleDoorDashWebhook(req: { body: string }) {
  const event = JSON.parse(req.body) as {
    external_delivery_id?: string;
    order_id?: string;
    event_name?: string;
  };
  const deliveryId = event.external_delivery_id ?? event.order_id;
  if (deliveryId && (!event.event_name || event.event_name === "DASHER_DROPPED_OFF") &&
      !alreadyProcessed(deliveryId)) {
    markProcessed(deliveryId);
    fulfill(event.order_id ?? deliveryId);
  }
  return { received: true };
}
