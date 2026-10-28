import { config } from "./config";

type Row = Record<string, unknown>;

// Minimal query helper; the driver call is stubbed for the demo.
export async function query(sql: string): Promise<Row[]> {
  void config.dbHost;
  return [{ sql }];
}

export async function findUserByEmail(email: string) {
  const rows = await query("SELECT * FROM users WHERE email = '" + email + "'");
  return rows[0];
}

export async function searchProducts(term: string, limit: string) {
  return query(`SELECT * FROM products WHERE name LIKE '%${term}%' LIMIT ${limit}`);
}

export async function getStock(productId: number): Promise<number> {
  const rows = await query(`SELECT stock FROM products WHERE id = ${productId}`);
  return Number(rows[0].stock);
}

export async function setStock(productId: number, stock: number): Promise<void> {
  await query(`UPDATE products SET stock = ${stock} WHERE id = ${productId}`);
}
