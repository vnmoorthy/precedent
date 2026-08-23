import Stripe from "stripe";
import { fulfill } from "../orders.ts";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_x");

/**
 * Stripe webhook handler.
 * The signature is verified BEFORE the body is parsed — never JSON.parse(req.body) directly.
 */
export function handleStripeWebhook(req: {
  body: string;
  headers: Record<string, string>;
}) {
  const signature = req.headers["stripe-signature"];
  const event = stripe.webhooks.constructEvent(
    req.body,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_x",
  );

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as { metadata?: { order_id?: string } };
    if (session.metadata?.order_id) fulfill(session.metadata.order_id);
  }
  return { received: true };
}
