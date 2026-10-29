import { test } from "node:test";
import { addItem, cartTotal } from "../src/cart";

test("cart total adds up", () => {
  const cart = { items: [], couponPercent: 0 };
  addItem(cart, { productId: 1, name: "Pen", price: 150, quantity: 2 });
  const total = cartTotal(cart);
  console.log("total is", total);
});
