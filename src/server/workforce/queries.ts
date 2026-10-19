import "server-only";
import { createClient } from "@/lib/supabase/server";

// Reads for the Workforce page. RLS: OWNER/ADMIN see the whole directory; a member sees only their own entry.
// Workload comes from organization_workload(), which refuses non-managers (an empty map is returned then).

export type DirectoryEntry = {
  id: string;
  email: string;
  userId: string | null;
  fullName: string | null;
  employeeCode: string | null;
  jobTitle: string | null;
  departmentId: string | null;
  department: string | null;
  teamId: string | null;
  team: string | null;
  availability: string;
  source: string;
  skills: { id: string; name: string }[];
};

export async function listDirectory(organizationId: string): Promise<DirectoryEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workforce_profiles")
    .select(
      "id, email, user_id, full_name, employee_code, job_title, department_id, team_id, availability, source, departments(name), teams(name), workforce_profile_skills(skills(id, name))",
    )
    .eq("organization_id", organizationId)
    .order("full_name", { nullsFirst: false })
    .order("email")
    .limit(2000);
  if (error) throw new Error("Failed to load the workforce directory.");
  return data.map((w) => ({
    id: w.id,
    email: w.email,
    userId: w.user_id,
    fullName: w.full_name,
    employeeCode: w.employee_code,
    jobTitle: w.job_title,
    departmentId: w.department_id,
    department: w.departments?.name ?? null,
    teamId: w.team_id,
    team: w.teams?.name ?? null,
    availability: w.availability,
    source: w.source,
    skills: w.workforce_profile_skills.flatMap((s) => (s.skills ? [s.skills] : [])).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export async function listSkills(organizationId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.from("skills").select("id, name").eq("organization_id", organizationId).order("name");
  if (error) throw new Error("Failed to load skills.");
  return data;
}

export type Workload = {
  activeTasks: number;
  inProgress: number;
  blocked: number;
  inReview: number;
  activeHours: number;
  unestimatedTasks: number;
  overdue: number;
};

export async function getWorkload(organizationId: string): Promise<Map<string, Workload>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("organization_workload", { p_organization_id: organizationId });
  if (error || !data) return new Map();
  return new Map(
    data.map((w) => [
      w.user_id,
      {
        activeTasks: w.active_tasks,
        inProgress: w.in_progress,
        blocked: w.blocked,
        inReview: w.in_review,
        activeHours: Number(w.active_hours),
        unestimatedTasks: w.unestimated_tasks,
        overdue: w.overdue,
      },
    ]),
  );
}

export async function getAssignmentMode(organizationId: string): Promise<"MANUAL" | "RECOMMEND" | "AUTO"> {
  const supabase = await createClient();
  const { data } = await supabase.from("organization_settings").select("assignment_mode").eq("organization_id", organizationId).maybeSingle();
  const mode = data?.assignment_mode;
  return mode === "RECOMMEND" || mode === "AUTO" ? mode : "MANUAL";
}

export async function listDepartmentsWithTeams(organizationId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("departments")
    .select("id, name, teams(id, name)")
    .eq("organization_id", organizationId)
    .order("name");
  if (error) throw new Error("Failed to load departments.");
  return data.map((d) => ({ id: d.id, name: d.name, teams: [...d.teams].sort((a, b) => a.name.localeCompare(b.name)) }));
}
