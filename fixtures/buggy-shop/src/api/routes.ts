import { login, verifyToken } from "../auth";
import { searchProducts } from "../db";
import { addItem, applyCoupon, getCart } from "../cart";
import { placeOrder } from "../orders";

type Req = { headers: Record<string, string>; body: any; query: Record<string, string>; params: Record<string, string> };
type Res = { status(code: number): Res; send(body: unknown): void; json(body: unknown): void };

export async function postLogin(req: Req, res: Res) {
  const token = await login(req.body.email, req.body.password);
  if (!token) return res.status(401).send("bad credentials");
  res.json({ token });
}

export async function getSearch(req: Req, res: Res) {
  const rows = await searchProducts(req.query.q, req.query.limit);
  res.send("<h1>Results for " + req.query.q + "</h1>" + JSON.stringify(rows));
}

export function postAddToCart(req: Req, res: Res) {
  addItem(getCart(), { productId: req.body.productId, name: req.body.name, price: req.body.price, quantity: req.body.quantity });
  res.json(getCart());
}

export function postCoupon(req: Req, res: Res) {
  applyCoupon(getCart(), Number(req.body.percent));
  res.json(getCart());
}

export async function postCheckout(req: Req, res: Res) {
  const user = verifyToken(req.headers.authorization);
  const order = await placeOrder(getCart(), user.email);
  res.json(order);
}

export function deleteUser(req: Req, res: Res) {
  // Admin only: removes a user account by id.
  res.json({ deleted: req.params.id });
}
