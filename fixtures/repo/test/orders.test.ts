import { expect, test } from "bun:test";
import { alreadyProcessed, fulfill, markProcessed } from "../src/orders.ts";

test("fulfill marks an order fulfilled", () => {
  expect(fulfill("ord_1").status).toBe("fulfilled");
});

test("delivery ids can be deduped", () => {
  expect(alreadyProcessed("dlv_1")).toBe(false);
  markProcessed("dlv_1");
  expect(alreadyProcessed("dlv_1")).toBe(true);
});
