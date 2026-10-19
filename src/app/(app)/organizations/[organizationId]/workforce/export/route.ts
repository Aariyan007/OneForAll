import { NextResponse } from "next/server";
import { DIRECTORY_COLUMNS, toCsv } from "@/lib/workforce/csv";
import { getOrgAccess } from "@/server/authz/access";
import { listDirectory } from "@/server/workforce/queries";

// Directory export in the import format (OWNER/ADMIN). Values that start like a spreadsheet formula are neutralized.
export async function GET(_request: Request, context: RouteContext<"/organizations/[organizationId]/workforce/export">) {
  const { organizationId } = await context.params;
  const access = await getOrgAccess(organizationId);
  if (!access || !access.can("workforce.view")) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const directory = await listDirectory(access.organization.id);
  const csv = toCsv(
    DIRECTORY_COLUMNS,
    directory.map((d) => [d.fullName, d.email, d.employeeCode, d.department, d.team, d.jobTitle, d.skills.map((s) => s.name).join(";"), d.availability]),
  );
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="workforce-${access.organization.slug}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
