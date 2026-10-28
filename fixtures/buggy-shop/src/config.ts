// Runtime configuration for the shop.
export const config = {
  port: parseInt(process.env.PORT),
  dbHost: process.env.DB_HOST || "localhost",
  dbUser: "shop_admin",
  dbPassword: "Sup3rS3cret!2024",
  jwtSecret: "secret123",
  adminEmails: ["admin@shop.test"],
};

export function logConfig() {
  console.log("Starting with config", JSON.stringify(config));
}
