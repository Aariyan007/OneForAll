import Link from "next/link";
import { notFound } from "next/navigation";
import { AiToggle } from "@/components/ai/ai-toggle";
import { RenameOrganizationForm } from "@/components/organizations/org-controls";
import { AssignmentModeControl } from "@/components/workforce/workforce-controls";
import { Card, CardHeader } from "@/components/ui/card";
import { IconSettings } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status";
import { ROLE_LABELS } from "@/lib/authz/permissions";
import { getOrgAccess } from "@/server/authz/access";
import { createClient } from "@/lib/supabase/server";
import { getAssignmentMode } from "@/server/workforce/queries";

export const metadata = { title: "Settings · OneForAll" };

// Organization settings (owners and admins). Every change is still authorized by the database: the rename by
// organizations_update_admin RLS, the assignment policy by set_assignment_mode() (owners only).
export default async function OrganizationSettingsPage({ params }: PageProps<"/organizations/[organizationId]/settings">) {
  const { organizationId } = await params;
  const access = await getOrgAccess(organizationId);
  if (!access || !access.can("org.settings.view")) notFound();
  const { organization, role } = access;
  const base = `/organizations/${organization.id}`;
  const mode = await getAssignmentMode(organization.id);
  const supabase = await createClient();
  const { data: settings } = await supabase.from("organization_settings").select("ai_enabled").eq("organization_id", organization.id).maybeSingle();

  return (
    <PageBody width="narrow">
      <PageHeader
        crumbs={[{ label: organization.name, href: `${base}/overview` }, { label: "Settings" }]}
        icon={<IconSettings size={18} />}
        title="Organization settings"
        description="Name, assignment policy, the AI assistant and where people and structure are managed."
        badges={<StatusBadge kind="role" value={role} label={`You: ${ROLE_LABELS[role]}`} />}
      />
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader title="General" />
          <div className="px-5 py-4">
            {access.can("org.rename") ? (
              <RenameOrganizationForm organizationId={organization.id} name={organization.name} />
            ) : (
              <p className="t-small text-fg-3">Only owners and admins can rename the organization.</p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Assignment policy" description="How new work finds the right person. Changing it is recorded in the activity log." />
          <div className="px-5 py-4">
            <AssignmentModeControl organizationId={organization.id} mode={mode} editable={access.can("org.assignmentPolicy.edit")} />
          </div>
        </Card>

        <Card>
          <CardHeader title="AI assistant" description="Grounded answers, requirement traces, reviews and test drafts on project snapshots. Changes are recorded in the activity log." />
          <div className="px-5 py-4">
            <AiToggle organizationId={organization.id} enabled={settings?.ai_enabled ?? true} editable={role === "OWNER" || role === "ADMIN"} />
          </div>
        </Card>

        <Card>
          <CardHeader title="People and structure" />
          <ul className="flex flex-col gap-2 px-5 py-4 text-[13px]">
            <li><Link href={`${base}/members`} className="text-fg hover:underline">Members and invitations</Link> <span className="text-fg-3">· roles, suspension, removal</span></li>
            <li><Link href={`${base}/workforce`} className="text-fg hover:underline">Workforce directory</Link> <span className="text-fg-3">· skills, availability, workload</span></li>
            {access.can("workforce.import") && (
              <li><Link href={`${base}/workforce/import`} className="text-fg hover:underline">Import from CSV</Link> <span className="text-fg-3">· employees, departments and teams</span></li>
            )}
            <li><Link href={`${base}/departments`} className="text-fg hover:underline">Departments and teams</Link></li>
          </ul>
        </Card>

        <Card>
          <CardHeader title="Not available" />
          <p className="t-small px-5 py-4 text-fg-3">
            Transferring ownership and deleting the organization are not offered: they are destructive and need separate safeguards. Owners keep full access
            and cannot be suspended or removed.
          </p>
        </Card>
      </div>
    </PageBody>
  );
}
