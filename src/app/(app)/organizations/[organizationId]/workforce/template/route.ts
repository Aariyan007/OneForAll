import { NextResponse, type NextRequest } from "next/server";
import { EMPLOYEES_TEMPLATE } from "@/lib/workforce/csv";
import { DEPARTMENTS_TEMPLATE, TEAMS_TEMPLATE } from "@/lib/workforce/structure-csv";
import { getOrgAccess } from "@/server/authz/access";

// CSV templates (fictional example rows): ?kind=departments | teams, otherwise the employee directory. Members of the
// organization only; every import still checks the caller's role on the server.
const TEMPLATES = {
  employees: { body: EMPLOYEES_TEMPLATE, file: "employees-template.csv" },
  departments: { body: DEPARTMENTS_TEMPLATE, file: "departments-template.csv" },
  teams: { body: TEAMS_TEMPLATE, file: "teams-template.csv" },
} as const;

export async function GET(request: NextRequest, context: RouteContext<"/organizations/[organizationId]/workforce/template">) {
  const { organizationId } = await context.params;
  if (!(await getOrgAccess(organizationId))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const kind = request.nextUrl.searchParams.get("kind");
  const template = kind === "departments" || kind === "teams" ? TEMPLATES[kind] : TEMPLATES.employees;
  return new NextResponse(template.body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${template.file}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
