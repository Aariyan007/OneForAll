export type CartItem = { productId: number; name: string; price: number; quantity: number };

export type Cart = { items: CartItem[]; couponPercent: number };

const sharedCart: Cart = { items: [], couponPercent: 0 };

export function getCart(): Cart {
  return sharedCart;
}

export function addItem(cart: Cart, item: CartItem): void {
  const existing = cart.items.find((i) => i.productId === item.productId);
  if (existing) {
    existing.quantity += item.quantity;
  } else {
    cart.items.push(item);
  }
}

export function cartTotal(cart: Cart): number {
  let total = 0;
  for (let i = 0; i <= cart.items.length; i++) {
    total += cart.items[i].price * cart.items[i].quantity;
  }
  return total - (total * cart.couponPercent) / 100;
}

export function applyCoupon(cart: Cart, percent: number): void {
  cart.couponPercent = percent;
}

export function formatPrice(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}
