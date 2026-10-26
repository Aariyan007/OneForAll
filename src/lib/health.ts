// Shape of GET /api/health. Only up/down states: no versions, hosts, counts or error text.

export type HealthBody = {
  status: "ok" | "degraded";
  checks: { app: "ok"; database: "ok" | "unreachable" };
  checkedAt: string;
};

export function healthReport(input: { database: boolean; checkedAt: string }): { httpStatus: 200 | 503; body: HealthBody } {
  return {
    httpStatus: input.database ? 200 : 503,
    body: {
      status: input.database ? "ok" : "degraded",
      checks: { app: "ok", database: input.database ? "ok" : "unreachable" },
      checkedAt: input.checkedAt,
    },
  };
}
