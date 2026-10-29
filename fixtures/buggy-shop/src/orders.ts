import { getStock, setStock } from "./db";
import { cartTotal, type Cart } from "./cart";

export async function placeOrder(cart: Cart, email: string) {
  for (const item of cart.items) {
    const stock = await getStock(item.productId);
    if (stock >= item.quantity) {
      await setStock(item.productId, stock - item.quantity);
    }
  }
  const total = cartTotal(cart);
  sendReceipt(email, total);
  return { email, total, placedAt: new Date() };
}

export async function cancelOrders(orderIds: number[]) {
  orderIds.forEach(async (id) => {
    await cancelOrder(id);
  });
  return "all orders cancelled";
}

async function cancelOrder(id: number) {
  if (id < 0) throw new Error("bad id");
  return id;
}

async function sendReceipt(email: string, total: number) {
  const res = await fetch("https://mail.shop.test/send", { method: "POST", body: JSON.stringify({ email, total }) });
  return res.json();
}
