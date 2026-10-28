
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "ai_run_events": {
                  Row: {
                    "created_at": string,"detail": Json | null,"id": number,"run_id": string,"state": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"detail"?: Json | null,"id"?: never,"run_id": string,"state": string
                  }
                  Update: {
                    "created_at"?: string,"detail"?: Json | null,"id"?: never,"run_id"?: string,"state"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ai_run_events_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "ai_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"ai_runs": {
                  Row: {
                    "attempts": number,"cached_input_tokens": number,"cancel_requested": boolean,"citations_dropped": number,"completed_at": string | null,"context_tokens_estimate": number,"correlation_id": string,"created_at": string,"error_category": string | null,"error_message": string | null,"estimated_cost_usd": number,"fallback_used": boolean,"id": string,"input": NonNullable<Json>,"input_tokens": number,"job_type": string,"model": string | null,"model_calls": number,"organization_id": string,"output": Json | null,"output_tokens": number,"project_id": string,"requested_by": string,"snapshot_id": string,"status": string,"thinking_tokens": number,"tier": string | null,"tool_calls": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"cached_input_tokens"?: number,"cancel_requested"?: boolean,"citations_dropped"?: number,"completed_at"?: string | null,"context_tokens_estimate"?: number,"correlation_id"?: string,"created_at"?: string,"error_category"?: string | null,"error_message"?: string | null,"estimated_cost_usd"?: number,"fallback_used"?: boolean,"id"?: string,"input": NonNullable<Json>,"input_tokens"?: number,"job_type": string,"model"?: string | null,"model_calls"?: number,"organization_id": string,"output"?: Json | null,"output_tokens"?: number,"project_id": string,"requested_by": string,"snapshot_id": string,"status"?: string,"thinking_tokens"?: number,"tier"?: string | null,"tool_calls"?: number,"updated_at"?: string
                  }
                  Update: {
                    "attempts"?: number,"cached_input_tokens"?: number,"cancel_requested"?: boolean,"citations_dropped"?: number,"completed_at"?: string | null,"context_tokens_estimate"?: number,"correlation_id"?: string,"created_at"?: string,"error_category"?: string | null,"error_message"?: string | null,"estimated_cost_usd"?: number,"fallback_used"?: boolean,"id"?: string,"input"?: NonNullable<Json>,"input_tokens"?: number,"job_type"?: string,"model"?: string | null,"model_calls"?: number,"organization_id"?: string,"output"?: Json | null,"output_tokens"?: number,"project_id"?: string,"requested_by"?: string,"snapshot_id"?: string,"status"?: string,"thinking_tokens"?: number,"tier"?: string | null,"tool_calls"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ai_runs_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ai_runs_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ai_runs_snapshot_id_fkey"
      columns: ["snapshot_id"]
isOneToOne: false
      referencedRelation: "repository_snapshots"
      referencedColumns: ["id"]
    }
                  ]
                },"department_members": {
                  Row: {
                    "created_at": string,"department_id": string,"id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"department_id": string,"id"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"department_id"?: string,"id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "department_members_department_id_fkey"
      columns: ["department_id"]
isOneToOne: false
      referencedRelation: "departments"
      referencedColumns: ["id"]
    }
                  ]
                },"departments": {
                  Row: {
                    "created_at": string,"created_by": string,"description": string | null,"id": string,"name": string,"organization_id": string,"slug": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by": string,"description"?: string | null,"id"?: string,"name": string,"organization_id": string,"slug": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string,"description"?: string | null,"id"?: string,"name"?: string,"organization_id"?: string,"slug"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "departments_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"jira_issues": {
                  Row: {
                    "assignee_name": string | null,"first_imported_at": string,"id": string,"integration_id": string,"issue_key": string,"issue_type": string | null,"jira_issue_id": string,"jira_project_key": string,"jira_site": string,"jira_updated_at": string | null,"last_synced_at": string,"missing_in_source": boolean,"priority_name": string | null,"project_id": string,"status_category": string,"status_name": string | null,"summary": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assignee_name"?: string | null,"first_imported_at"?: string,"id"?: string,"integration_id": string,"issue_key": string,"issue_type"?: string | null,"jira_issue_id": string,"jira_project_key": string,"jira_site": string,"jira_updated_at"?: string | null,"last_synced_at"?: string,"missing_in_source"?: boolean,"priority_name"?: string | null,"project_id": string,"status_category"?: string,"status_name"?: string | null,"summary": string
                  }
                  Update: {
                    "assignee_name"?: string | null,"first_imported_at"?: string,"id"?: string,"integration_id"?: string,"issue_key"?: string,"issue_type"?: string | null,"jira_issue_id"?: string,"jira_project_key"?: string,"jira_site"?: string,"jira_updated_at"?: string | null,"last_synced_at"?: string,"missing_in_source"?: boolean,"priority_name"?: string | null,"project_id"?: string,"status_category"?: string,"status_name"?: string | null,"summary"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "jira_issues_integration_id_fkey"
      columns: ["integration_id"]
isOneToOne: false
      referencedRelation: "project_integrations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "jira_issues_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    }
                  ]
                },"notifications": {
                  Row: {
                    "body": string | null,"created_at": string,"dedupe_key": string,"id": string,"link": string | null,"organization_id": string,"read_at": string | null,"task_id": string | null,"title": string,"type": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body"?: string | null,"created_at"?: string,"dedupe_key": string,"id"?: string,"link"?: string | null,"organization_id": string,"read_at"?: string | null,"task_id"?: string | null,"title": string,"type": string,"user_id": string
                  }
                  Update: {
                    "body"?: string | null,"created_at"?: string,"dedupe_key"?: string,"id"?: string,"link"?: string | null,"organization_id"?: string,"read_at"?: string | null,"task_id"?: string | null,"title"?: string,"type"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notifications_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notifications_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"organization_audit_events": {
                  Row: {
                    "action": string,"actor_id": string | null,"created_at": string,"details": NonNullable<Json>,"id": number,"organization_id": string,"target_email": string | null,"target_user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"created_at"?: string,"details"?: NonNullable<Json>,"id"?: never,"organization_id": string,"target_email"?: string | null,"target_user_id"?: string | null
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"created_at"?: string,"details"?: NonNullable<Json>,"id"?: never,"organization_id"?: string,"target_email"?: string | null,"target_user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "organization_audit_events_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"organization_invitations": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"created_at": string,"email": string,"expires_at": string,"id": string,"invited_by": string | null,"organization_id": string,"revoked_at": string | null,"revoked_by": string | null,"role": string,"status": string,"token_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"email": string,"expires_at": string,"id"?: string,"invited_by"?: string | null,"organization_id": string,"revoked_at"?: string | null,"revoked_by"?: string | null,"role": string,"status"?: string,"token_hash": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"email"?: string,"expires_at"?: string,"id"?: string,"invited_by"?: string | null,"organization_id"?: string,"revoked_at"?: string | null,"revoked_by"?: string | null,"role"?: string,"status"?: string,"token_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organization_invitations_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"organization_members": {
                  Row: {
                    "created_at": string,"id": string,"organization_id": string,"role": string,"status": string,"suspended_at": string | null,"suspended_by": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"organization_id": string,"role": string,"status"?: string,"suspended_at"?: string | null,"suspended_by"?: string | null,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"organization_id"?: string,"role"?: string,"status"?: string,"suspended_at"?: string | null,"suspended_by"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organization_members_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"organization_settings": {
                  Row: {
                    "ai_enabled": boolean,"assignment_mode": string,"organization_id": string,"updated_at": string,"updated_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "ai_enabled"?: boolean,"assignment_mode"?: string,"organization_id": string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "ai_enabled"?: boolean,"assignment_mode"?: string,"organization_id"?: string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "organization_settings_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: true
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"organizations": {
                  Row: {
                    "created_at": string,"created_by": string,"id": string,"name": string,"slug": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by": string,"id"?: string,"name": string,"slug": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string,"id"?: string,"name"?: string,"slug"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"profiles": {
                  Row: {
                    "avatar_url": string | null,"created_at": string,"display_name": string | null,"email": string,"id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "avatar_url"?: string | null,"created_at"?: string,"display_name"?: string | null,"email": string,"id": string,"updated_at"?: string
                  }
                  Update: {
                    "avatar_url"?: string | null,"created_at"?: string,"display_name"?: string | null,"email"?: string,"id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"project_integrations": {
                  Row: {
                    "created_at": string,"created_by": string | null,"has_credential": boolean,"id": string,"jira_account_email": string | null,"jira_project_id": string | null,"jira_project_key": string | null,"jira_project_name": string | null,"jira_site": string | null,"kind": string,"last_checked_at": string | null,"last_error": string | null,"last_sync_at": string | null,"last_sync_message": string | null,"last_sync_status": string | null,"project_id": string,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"has_credential"?: boolean,"id"?: string,"jira_account_email"?: string | null,"jira_project_id"?: string | null,"jira_project_key"?: string | null,"jira_project_name"?: string | null,"jira_site"?: string | null,"kind": string,"last_checked_at"?: string | null,"last_error"?: string | null,"last_sync_at"?: string | null,"last_sync_message"?: string | null,"last_sync_status"?: string | null,"project_id": string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"has_credential"?: boolean,"id"?: string,"jira_account_email"?: string | null,"jira_project_id"?: string | null,"jira_project_key"?: string | null,"jira_project_name"?: string | null,"jira_site"?: string | null,"kind"?: string,"last_checked_at"?: string | null,"last_error"?: string | null,"last_sync_at"?: string | null,"last_sync_message"?: string | null,"last_sync_status"?: string | null,"project_id"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_integrations_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    }
                  ]
                },"project_teams": {
                  Row: {
                    "added_by": string | null,"created_at": string,"project_id": string,"team_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "added_by"?: string | null,"created_at"?: string,"project_id": string,"team_id": string
                  }
                  Update: {
                    "added_by"?: string | null,"created_at"?: string,"project_id"?: string,"team_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_teams_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "project_teams_team_id_fkey"
      columns: ["team_id"]
isOneToOne: false
      referencedRelation: "teams"
      referencedColumns: ["id"]
    }
                  ]
                },"projects": {
                  Row: {
                    "created_at": string,"created_by": string,"description": string | null,"id": string,"name": string,"project_type": string,"slug": string,"status": string,"team_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by": string,"description"?: string | null,"id"?: string,"name": string,"project_type": string,"slug": string,"status"?: string,"team_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string,"description"?: string | null,"id"?: string,"name"?: string,"project_type"?: string,"slug"?: string,"status"?: string,"team_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "projects_team_id_fkey"
      columns: ["team_id"]
isOneToOne: false
      referencedRelation: "teams"
      referencedColumns: ["id"]
    }
                  ]
                },"repositories": {
                  Row: {
                    "created_at": string,"created_by": string,"default_branch": string,"id": string,"name": string,"owner": string,"project_id": string,"provider": string,"repository_url": string,"status": string,"updated_at": string,"visibility": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by": string,"default_branch": string,"id"?: string,"name": string,"owner": string,"project_id": string,"provider": string,"repository_url": string,"status"?: string,"updated_at"?: string,"visibility"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string,"default_branch"?: string,"id"?: string,"name"?: string,"owner"?: string,"project_id"?: string,"provider"?: string,"repository_url"?: string,"status"?: string,"updated_at"?: string,"visibility"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repositories_project_id_fkey"
      columns: ["project_id"]
isOneToOne: true
      referencedRelation: "projects"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_bug_events": {
                  Row: {
                    "actor_id": string | null,"bug_id": string,"created_at": string,"details": NonNullable<Json>,"from_status": string | null,"id": number,"to_status": string | null,"type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"bug_id": string,"created_at"?: string,"details"?: NonNullable<Json>,"from_status"?: string | null,"id"?: never,"to_status"?: string | null,"type": string
                  }
                  Update: {
                    "actor_id"?: string | null,"bug_id"?: string,"created_at"?: string,"details"?: NonNullable<Json>,"from_status"?: string | null,"id"?: never,"to_status"?: string | null,"type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_bug_events_bug_id_fkey"
      columns: ["bug_id"]
isOneToOne: false
      referencedRelation: "repository_bugs"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_bug_fix_files": {
                  Row: {
                    "base_hash": string,"fix_id": string,"patched_content": string,"patched_hash": string,"path": string
                  }
                  ComputedFields: never
                  Insert: {
                    "base_hash": string,"fix_id": string,"patched_content": string,"patched_hash": string,"path": string
                  }
                  Update: {
                    "base_hash"?: string,"fix_id"?: string,"patched_content"?: string,"patched_hash"?: string,"path"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_bug_fix_files_fix_id_fkey"
      columns: ["fix_id"]
isOneToOne: false
      referencedRelation: "repository_bug_fixes"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_bug_fixes": {
                  Row: {
                    "bug_id": string,"created_at": string,"created_by": string | null,"decided_at": string | null,"decided_by": string | null,"decision_note": string | null,"diff": string,"edits": NonNullable<Json>,"id": string,"model": string | null,"organization_id": string,"plan": NonNullable<Json>,"project_id": string,"run_id": string | null,"status": string,"updated_at": string,"validation": Json | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "bug_id": string,"created_at"?: string,"created_by"?: string | null,"decided_at"?: string | null,"decided_by"?: string | null,"decision_note"?: string | null,"diff": string,"edits": NonNullable<Json>,"id"?: string,"model"?: string | null,"organization_id": string,"plan": NonNullable<Json>,"project_id": string,"run_id"?: string | null,"status"?: string,"updated_at"?: string,"validation"?: Json | null,"version": number
                  }
                  Update: {
                    "bug_id"?: string,"created_at"?: string,"created_by"?: string | null,"decided_at"?: string | null,"decided_by"?: string | null,"decision_note"?: string | null,"diff"?: string,"edits"?: NonNullable<Json>,"id"?: string,"model"?: string | null,"organization_id"?: string,"plan"?: NonNullable<Json>,"project_id"?: string,"run_id"?: string | null,"status"?: string,"updated_at"?: string,"validation"?: Json | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_bug_fixes_bug_id_fkey"
      columns: ["bug_id"]
isOneToOne: false
      referencedRelation: "repository_bugs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_bug_fixes_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_bug_fixes_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_bug_fixes_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "ai_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_bug_scans": {
                  Row: {
                    "batches_total": number,"bugs_found": number,"bugs_new": number,"completed_at": string | null,"completed_batches": (number)[],"cost_usd": number,"created_at": string,"error_message": string | null,"failed_batches": (number)[],"files_planned": number,"files_total": number,"id": string,"input_tokens": number,"organization_id": string,"output_tokens": number,"plan": NonNullable<Json>,"project_id": string,"snapshot_id": string,"started_by": string | null,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "batches_total": number,"bugs_found"?: number,"bugs_new"?: number,"completed_at"?: string | null,"completed_batches"?: (number)[],"cost_usd"?: number,"created_at"?: string,"error_message"?: string | null,"failed_batches"?: (number)[],"files_planned": number,"files_total": number,"id"?: string,"input_tokens"?: number,"organization_id": string,"output_tokens"?: number,"plan": NonNullable<Json>,"project_id": string,"snapshot_id": string,"started_by"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "batches_total"?: number,"bugs_found"?: number,"bugs_new"?: number,"completed_at"?: string | null,"completed_batches"?: (number)[],"cost_usd"?: number,"created_at"?: string,"error_message"?: string | null,"failed_batches"?: (number)[],"files_planned"?: number,"files_total"?: number,"id"?: string,"input_tokens"?: number,"organization_id"?: string,"output_tokens"?: number,"plan"?: NonNullable<Json>,"project_id"?: string,"snapshot_id"?: string,"started_by"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_bug_scans_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_bug_scans_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_bug_scans_snapshot_id_fkey"
      columns: ["snapshot_id"]
isOneToOne: false
      referencedRelation: "repository_snapshots"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_bugs": {
                  Row: {
                    "assigned_at": string | null,"assigned_by": string | null,"assigned_to": string | null,"assignment_reason": string | null,"assignment_source": string | null,"category": string,"confidence": number,"created_at": string,"description": string,"end_line": number,"evidence": string,"file_id": string | null,"file_path": string,"fingerprint": string,"first_scan_id": string | null,"id": string,"last_scan_id": string | null,"organization_id": string,"project_id": string,"severity": string,"severity_reason": string,"snapshot_id": string,"start_line": number,"status": string,"suggested_fix": string,"times_seen": number,"title": string,"updated_at": string,"validation_steps": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assigned_at"?: string | null,"assigned_by"?: string | null,"assigned_to"?: string | null,"assignment_reason"?: string | null,"assignment_source"?: string | null,"category": string,"confidence": number,"created_at"?: string,"description": string,"end_line": number,"evidence": string,"file_id"?: string | null,"file_path": string,"fingerprint": string,"first_scan_id"?: string | null,"id"?: string,"last_scan_id"?: string | null,"organization_id": string,"project_id": string,"severity": string,"severity_reason": string,"snapshot_id": string,"start_line": number,"status"?: string,"suggested_fix"?: string,"times_seen"?: number,"title": string,"updated_at"?: string,"validation_steps"?: string
                  }
                  Update: {
                    "assigned_at"?: string | null,"assigned_by"?: string | null,"assigned_to"?: string | null,"assignment_reason"?: string | null,"assignment_source"?: string | null,"category"?: string,"confidence"?: number,"created_at"?: string,"description"?: string,"end_line"?: number,"evidence"?: string,"file_id"?: string | null,"file_path"?: string,"fingerprint"?: string,"first_scan_id"?: string | null,"id"?: string,"last_scan_id"?: string | null,"organization_id"?: string,"project_id"?: string,"severity"?: string,"severity_reason"?: string,"snapshot_id"?: string,"start_line"?: number,"status"?: string,"suggested_fix"?: string,"times_seen"?: number,"title"?: string,"updated_at"?: string,"validation_steps"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_bugs_file_id_fkey"
      columns: ["file_id"]
isOneToOne: false
      referencedRelation: "repository_files"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_bugs_first_scan_id_fkey"
      columns: ["first_scan_id"]
isOneToOne: false
      referencedRelation: "repository_bug_scans"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_bugs_last_scan_id_fkey"
      columns: ["last_scan_id"]
isOneToOne: false
      referencedRelation: "repository_bug_scans"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_bugs_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_bugs_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_bugs_snapshot_id_fkey"
      columns: ["snapshot_id"]
isOneToOne: false
      referencedRelation: "repository_snapshots"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_file_contents": {
                  Row: {
                    "byte_size": number,"content": string,"created_at": string,"file_id": string,"snapshot_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "byte_size": number,"content": string,"created_at"?: string,"file_id": string,"snapshot_id": string
                  }
                  Update: {
                    "byte_size"?: number,"content"?: string,"created_at"?: string,"file_id"?: string,"snapshot_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_file_contents_file_id_fkey"
      columns: ["file_id"]
isOneToOne: true
      referencedRelation: "repository_files"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_file_contents_snapshot_id_fkey"
      columns: ["snapshot_id"]
isOneToOne: false
      referencedRelation: "repository_snapshots"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_file_edges": {
                  Row: {
                    "created_at": string,"id": number,"kind": string,"snapshot_id": string,"source_file_id": string,"specifier": string,"target_file_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: never,"kind": string,"snapshot_id": string,"source_file_id": string,"specifier": string,"target_file_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: never,"kind"?: string,"snapshot_id"?: string,"source_file_id"?: string,"specifier"?: string,"target_file_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_file_edges_snapshot_id_fkey"
      columns: ["snapshot_id"]
isOneToOne: false
      referencedRelation: "repository_snapshots"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_file_edges_source_file_id_fkey"
      columns: ["source_file_id"]
isOneToOne: false
      referencedRelation: "repository_files"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_file_edges_target_file_id_fkey"
      columns: ["target_file_id"]
isOneToOne: false
      referencedRelation: "repository_files"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_files": {
                  Row: {
                    "content_hash": string,"created_at": string,"id": string,"language": string | null,"path": string,"size_bytes": number,"snapshot_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "content_hash": string,"created_at"?: string,"id"?: string,"language"?: string | null,"path": string,"size_bytes": number,"snapshot_id": string
                  }
                  Update: {
                    "content_hash"?: string,"created_at"?: string,"id"?: string,"language"?: string | null,"path"?: string,"size_bytes"?: number,"snapshot_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_files_snapshot_id_fkey"
      columns: ["snapshot_id"]
isOneToOne: false
      referencedRelation: "repository_snapshots"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_snapshot_sources": {
                  Row: {
                    "archive_bytes": number,"archive_commit": string | null,"archive_format": string,"archive_sha256": string,"created_at": string,"entries_total": number,"files_accepted": number,"files_skipped": number,"files_skipped_generated": number | null,"files_skipped_metadata": number | null,"files_skipped_oversized": number | null,"files_skipped_sensitive": number | null,"snapshot_id": string,"source_kind": string,"uploaded_by": string | null,"verification": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archive_bytes": number,"archive_commit"?: string | null,"archive_format": string,"archive_sha256": string,"created_at"?: string,"entries_total": number,"files_accepted": number,"files_skipped": number,"files_skipped_generated"?: number | null,"files_skipped_metadata"?: number | null,"files_skipped_oversized"?: number | null,"files_skipped_sensitive"?: number | null,"snapshot_id": string,"source_kind": string,"uploaded_by"?: string | null,"verification"?: string
                  }
                  Update: {
                    "archive_bytes"?: number,"archive_commit"?: string | null,"archive_format"?: string,"archive_sha256"?: string,"created_at"?: string,"entries_total"?: number,"files_accepted"?: number,"files_skipped"?: number,"files_skipped_generated"?: number | null,"files_skipped_metadata"?: number | null,"files_skipped_oversized"?: number | null,"files_skipped_sensitive"?: number | null,"snapshot_id"?: string,"source_kind"?: string,"uploaded_by"?: string | null,"verification"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_snapshot_sources_snapshot_id_fkey"
      columns: ["snapshot_id"]
isOneToOne: true
      referencedRelation: "repository_snapshots"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_snapshots": {
                  Row: {
                    "branch": string,"commit_sha": string,"completed_at": string | null,"created_at": string,"error_message": string | null,"id": string,"repository_id": string,"started_at": string | null,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch": string,"commit_sha": string,"completed_at"?: string | null,"created_at"?: string,"error_message"?: string | null,"id"?: string,"repository_id": string,"started_at"?: string | null,"status"?: string
                  }
                  Update: {
                    "branch"?: string,"commit_sha"?: string,"completed_at"?: string | null,"created_at"?: string,"error_message"?: string | null,"id"?: string,"repository_id"?: string,"started_at"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_snapshots_repository_id_fkey"
      columns: ["repository_id"]
isOneToOne: false
      referencedRelation: "repositories"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_structure_analyses": {
                  Row: {
                    "completed_at": string | null,"created_at": string,"error_message": string | null,"files_analyzed": number,"files_failed": number,"files_total": number,"files_unsupported": number,"id": string,"relationships_count": number,"snapshot_id": string,"started_at": string | null,"status": string,"symbols_count": number
                  }
                  ComputedFields: never
                  Insert: {
                    "completed_at"?: string | null,"created_at"?: string,"error_message"?: string | null,"files_analyzed"?: number,"files_failed"?: number,"files_total"?: number,"files_unsupported"?: number,"id"?: string,"relationships_count"?: number,"snapshot_id": string,"started_at"?: string | null,"status"?: string,"symbols_count"?: number
                  }
                  Update: {
                    "completed_at"?: string | null,"created_at"?: string,"error_message"?: string | null,"files_analyzed"?: number,"files_failed"?: number,"files_total"?: number,"files_unsupported"?: number,"id"?: string,"relationships_count"?: number,"snapshot_id"?: string,"started_at"?: string | null,"status"?: string,"symbols_count"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_structure_analyses_snapshot_id_fkey"
      columns: ["snapshot_id"]
isOneToOne: true
      referencedRelation: "repository_snapshots"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_symbol_relationships": {
                  Row: {
                    "analysis_id": string,"created_at": string,"id": string,"relationship_type": string,"source_symbol_id": string,"target_symbol_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "analysis_id": string,"created_at"?: string,"id"?: string,"relationship_type": string,"source_symbol_id": string,"target_symbol_id": string
                  }
                  Update: {
                    "analysis_id"?: string,"created_at"?: string,"id"?: string,"relationship_type"?: string,"source_symbol_id"?: string,"target_symbol_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_symbol_relationships_analysis_id_fkey"
      columns: ["analysis_id"]
isOneToOne: false
      referencedRelation: "repository_structure_analyses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_symbol_relationships_source_symbol_id_fkey"
      columns: ["source_symbol_id"]
isOneToOne: false
      referencedRelation: "repository_symbols"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_symbol_relationships_target_symbol_id_fkey"
      columns: ["target_symbol_id"]
isOneToOne: false
      referencedRelation: "repository_symbols"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_symbols": {
                  Row: {
                    "analysis_id": string,"created_at": string,"end_column": number,"end_line": number,"file_id": string,"id": string,"kind": string,"name": string,"qualified_name": string | null,"signature": string | null,"start_column": number,"start_line": number,"visibility": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "analysis_id": string,"created_at"?: string,"end_column": number,"end_line": number,"file_id": string,"id"?: string,"kind": string,"name": string,"qualified_name"?: string | null,"signature"?: string | null,"start_column": number,"start_line": number,"visibility"?: string | null
                  }
                  Update: {
                    "analysis_id"?: string,"created_at"?: string,"end_column"?: number,"end_line"?: number,"file_id"?: string,"id"?: string,"kind"?: string,"name"?: string,"qualified_name"?: string | null,"signature"?: string | null,"start_column"?: number,"start_line"?: number,"visibility"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_symbols_analysis_id_fkey"
      columns: ["analysis_id"]
isOneToOne: false
      referencedRelation: "repository_structure_analyses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_symbols_file_id_fkey"
      columns: ["file_id"]
isOneToOne: false
      referencedRelation: "repository_files"
      referencedColumns: ["id"]
    }
                  ]
                },"requirements": {
                  Row: {
                    "created_at": string,"created_by": string,"description": string | null,"id": string,"priority": string,"project_id": string,"status": string,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by": string,"description"?: string | null,"id"?: string,"priority"?: string,"project_id": string,"status"?: string,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string,"description"?: string | null,"id"?: string,"priority"?: string,"project_id"?: string,"status"?: string,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "requirements_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    }
                  ]
                },"skills": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"name": string,"organization_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"name": string,"organization_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"name"?: string,"organization_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "skills_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"task_comments": {
                  Row: {
                    "author_id": string | null,"body": string,"created_at": string,"id": string,"task_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "author_id"?: string | null,"body": string,"created_at"?: string,"id"?: string,"task_id": string
                  }
                  Update: {
                    "author_id"?: string | null,"body"?: string,"created_at"?: string,"id"?: string,"task_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_comments_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"task_defects": {
                  Row: {
                    "details": string | null,"id": string,"reported_at": string,"reported_by": string | null,"resolution": string | null,"resolved_at": string | null,"resolved_by": string | null,"severity": string,"status": string,"task_id": string,"title": string
                  }
                  ComputedFields: never
                  Insert: {
                    "details"?: string | null,"id"?: string,"reported_at"?: string,"reported_by"?: string | null,"resolution"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"severity"?: string,"status"?: string,"task_id": string,"title": string
                  }
                  Update: {
                    "details"?: string | null,"id"?: string,"reported_at"?: string,"reported_by"?: string | null,"resolution"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"severity"?: string,"status"?: string,"task_id"?: string,"title"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_defects_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"task_dependencies": {
                  Row: {
                    "created_at": string,"created_by": string | null,"depends_on_task_id": string,"task_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"depends_on_task_id": string,"task_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"depends_on_task_id"?: string,"task_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_dependencies_depends_on_task_id_fkey"
      columns: ["depends_on_task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_dependencies_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"task_events": {
                  Row: {
                    "actor_id": string | null,"created_at": string,"details": NonNullable<Json>,"event_type": string,"from_status": string | null,"id": number,"task_id": string,"to_status": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"created_at"?: string,"details"?: NonNullable<Json>,"event_type": string,"from_status"?: string | null,"id"?: never,"task_id": string,"to_status"?: string | null
                  }
                  Update: {
                    "actor_id"?: string | null,"created_at"?: string,"details"?: NonNullable<Json>,"event_type"?: string,"from_status"?: string | null,"id"?: never,"task_id"?: string,"to_status"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_events_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"task_handoffs": {
                  Row: {
                    "created_at": string,"created_by": string | null,"from_team_id": string | null,"id": string,"notes": string | null,"remaining_work": string | null,"responded_at": string | null,"responded_by": string | null,"response_note": string | null,"status": string,"summary": string,"task_id": string,"to_team_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"from_team_id"?: string | null,"id"?: string,"notes"?: string | null,"remaining_work"?: string | null,"responded_at"?: string | null,"responded_by"?: string | null,"response_note"?: string | null,"status"?: string,"summary": string,"task_id": string,"to_team_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"from_team_id"?: string | null,"id"?: string,"notes"?: string | null,"remaining_work"?: string | null,"responded_at"?: string | null,"responded_by"?: string | null,"response_note"?: string | null,"status"?: string,"summary"?: string,"task_id"?: string,"to_team_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_handoffs_from_team_id_fkey"
      columns: ["from_team_id"]
isOneToOne: false
      referencedRelation: "teams"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_handoffs_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_handoffs_to_team_id_fkey"
      columns: ["to_team_id"]
isOneToOne: false
      referencedRelation: "teams"
      referencedColumns: ["id"]
    }
                  ]
                },"task_links": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"label": string | null,"task_id": string,"url": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"label"?: string | null,"task_id": string,"url": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"label"?: string | null,"task_id"?: string,"url"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_links_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"task_required_skills": {
                  Row: {
                    "skill_id": string,"task_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "skill_id": string,"task_id": string
                  }
                  Update: {
                    "skill_id"?: string,"task_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_required_skills_skill_id_fkey"
      columns: ["skill_id"]
isOneToOne: false
      referencedRelation: "skills"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_required_skills_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"tasks": {
                  Row: {
                    "acceptance_criteria": string | null,"assigned_at": string | null,"assigned_by": string | null,"assignee_id": string | null,"created_at": string,"created_by": string,"description": string | null,"due_date": string | null,"estimated_hours": number | null,"id": string,"priority": string,"qa_required": boolean,"requirement_id": string,"status": string,"team_id": string | null,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "acceptance_criteria"?: string | null,"assigned_at"?: string | null,"assigned_by"?: string | null,"assignee_id"?: string | null,"created_at"?: string,"created_by": string,"description"?: string | null,"due_date"?: string | null,"estimated_hours"?: number | null,"id"?: string,"priority"?: string,"qa_required"?: boolean,"requirement_id": string,"status"?: string,"team_id"?: string | null,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "acceptance_criteria"?: string | null,"assigned_at"?: string | null,"assigned_by"?: string | null,"assignee_id"?: string | null,"created_at"?: string,"created_by"?: string,"description"?: string | null,"due_date"?: string | null,"estimated_hours"?: number | null,"id"?: string,"priority"?: string,"qa_required"?: boolean,"requirement_id"?: string,"status"?: string,"team_id"?: string | null,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tasks_requirement_id_fkey"
      columns: ["requirement_id"]
isOneToOne: false
      referencedRelation: "requirements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_team_id_fkey"
      columns: ["team_id"]
isOneToOne: false
      referencedRelation: "teams"
      referencedColumns: ["id"]
    }
                  ]
                },"team_members": {
                  Row: {
                    "created_at": string,"id": string,"team_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"team_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"team_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "team_members_team_id_fkey"
      columns: ["team_id"]
isOneToOne: false
      referencedRelation: "teams"
      referencedColumns: ["id"]
    }
                  ]
                },"teams": {
                  Row: {
                    "created_at": string,"created_by": string,"department_id": string,"description": string | null,"id": string,"name": string,"slug": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by": string,"department_id": string,"description"?: string | null,"id"?: string,"name": string,"slug": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string,"department_id"?: string,"description"?: string | null,"id"?: string,"name"?: string,"slug"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "teams_department_id_fkey"
      columns: ["department_id"]
isOneToOne: false
      referencedRelation: "departments"
      referencedColumns: ["id"]
    }
                  ]
                },"workforce_profile_skills": {
                  Row: {
                    "created_at": string,"profile_id": string,"skill_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"profile_id": string,"skill_id": string
                  }
                  Update: {
                    "created_at"?: string,"profile_id"?: string,"skill_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "workforce_profile_skills_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "workforce_profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "workforce_profile_skills_skill_id_fkey"
      columns: ["skill_id"]
isOneToOne: false
      referencedRelation: "skills"
      referencedColumns: ["id"]
    }
                  ]
                },"workforce_profiles": {
                  Row: {
                    "availability": string,"created_at": string,"created_by": string | null,"department_id": string | null,"email": string,"employee_code": string | null,"full_name": string | null,"id": string,"job_title": string | null,"organization_id": string,"source": string,"team_id": string | null,"updated_at": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "availability"?: string,"created_at"?: string,"created_by"?: string | null,"department_id"?: string | null,"email": string,"employee_code"?: string | null,"full_name"?: string | null,"id"?: string,"job_title"?: string | null,"organization_id": string,"source"?: string,"team_id"?: string | null,"updated_at"?: string,"user_id"?: string | null
                  }
                  Update: {
                    "availability"?: string,"created_at"?: string,"created_by"?: string | null,"department_id"?: string | null,"email"?: string,"employee_code"?: string | null,"full_name"?: string | null,"id"?: string,"job_title"?: string | null,"organization_id"?: string,"source"?: string,"team_id"?: string | null,"updated_at"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "workforce_profiles_department_id_fkey"
      columns: ["department_id"]
isOneToOne: false
      referencedRelation: "departments"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "workforce_profiles_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "workforce_profiles_team_id_fkey"
      columns: ["team_id"]
isOneToOne: false
      referencedRelation: "teams"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_organization_invitation":
{ Args: { "p_token": string }; Returns: string
                           },
"add_bug_comment":
{ Args: { "p_body": string,"p_bug_id": string }; Returns: undefined
                           },
"add_project_team":
{ Args: { "p_project_id": string,"p_team_id": string }; Returns: undefined
                           },
"add_task_comment":
{ Args: { "p_body": string,"p_mentions"?: (string)[],"p_task_id": string }; Returns: string
                           },
"add_task_dependency":
{ Args: { "p_depends_on": string,"p_task_id": string }; Returns: undefined
                           },
"add_task_link":
{ Args: { "p_label": string,"p_task_id": string,"p_url": string }; Returns: string
                           },
"assign_bug":
{ Args: { "p_assignee": string,"p_bug_id": string,"p_reason": string,"p_source": string }; Returns: undefined
                           },
"assign_task":
{ Args: { "p_assignee": string,"p_expected_assignee": string,"p_mode"?: string,"p_reason"?: string,"p_task_id": string }; Returns: undefined
                           },
"begin_snapshot_ingestion":
{ Args: { "p_snapshot_id": string }; Returns: {
              "run_token": string,"snapshot_id": string
            }[]
                           },
"begin_structure_analysis":
{ Args: { "p_analysis_id": string }; Returns: {
              "analysis_id": string,"run_token": string
            }[]
                           },
"can_see_project":
{ Args: { "p_project_id": string }; Returns: boolean
                           },
"change_member_role":
{ Args: { "p_member_id": string,"p_role": string }; Returns: undefined
                           },
"close_expired_invitations":
{ Args: { "p_organization_id": string }; Returns: number
                           },
"create_department":
{ Args: { "p_description"?: string,"p_name": string,"p_organization_id": string }; Returns: {
              "description": string,"id": string,"name": string,"organization_id": string,"slug": string
            }[]
                           },
"create_organization":
{ Args: { "p_name": string }; Returns: {
              "id": string,"name": string,"role": string,"slug": string
            }[]
                           },
"create_organization_invitation":
{ Args: { "p_email": string,"p_organization_id": string,"p_role": string }; Returns: {
              "expires_at": string,"invitation_id": string,"token": string
            }[]
                           },
"create_project":
{ Args: { "p_description"?: string,"p_name": string,"p_project_type"?: string,"p_team_id": string }; Returns: {
              "description": string,"id": string,"name": string,"project_type": string,"slug": string,"status": string,"team_id": string
            }[]
                           },
"create_repository":
{ Args: { "p_default_branch": string,"p_name": string,"p_owner": string,"p_project_id": string,"p_provider": string,"p_repository_url": string,"p_visibility"?: string }; Returns: {
              "default_branch": string,"id": string,"name": string,"owner": string,"project_id": string,"provider": string,"repository_url": string,"status": string,"visibility": string
            }[]
                           },
"create_repository_snapshot":
{ Args: { "p_branch": string,"p_commit_sha": string,"p_repository_id": string }; Returns: {
              "branch": string,"commit_sha": string,"created_at": string,"id": string,"repository_id": string,"status": string
            }[]
                           },
"create_requirement":
{ Args: { "p_description"?: string,"p_priority"?: string,"p_project_id": string,"p_title": string }; Returns: {
              "description": string,"id": string,"priority": string,"project_id": string,"status": string,"title": string
            }[]
                           },
"create_skill":
{ Args: { "p_name": string,"p_organization_id": string }; Returns: string
                           },
"create_structure_analysis":
{ Args: { "p_snapshot_id": string }; Returns: {
              "created_at": string,"id": string,"snapshot_id": string,"status": string
            }[]
                           },
"create_task":
{ Args: { "p_description"?: string,"p_priority"?: string,"p_requirement_id": string,"p_title": string }; Returns: {
              "description": string,"id": string,"priority": string,"requirement_id": string,"status": string,"title": string
            }[]
                           },
"create_task_handoff":
{ Args: { "p_notes": string,"p_remaining": string,"p_summary": string,"p_task_id": string,"p_to_team_id": string }; Returns: string
                           },
"create_team":
{ Args: { "p_department_id": string,"p_description"?: string,"p_name": string }; Returns: {
              "department_id": string,"description": string,"id": string,"name": string,"slug": string
            }[]
                           },
"decide_bug_fix":
{ Args: { "p_decision": string,"p_fix_id": string,"p_note": string }; Returns: undefined
                           },
"decline_task_assignment":
{ Args: { "p_reason": string,"p_task_id": string }; Returns: undefined
                           },
"disconnect_project_integration":
{ Args: { "p_integration_id": string }; Returns: undefined
                           },
"fail_snapshot_ingestion":
{ Args: { "p_error_message": string,"p_run_token": string,"p_snapshot_id": string }; Returns: {
              "snapshot_id": string,"status": string
            }[]
                           },
"fail_stale_snapshot_ingestion":
{ Args: { "p_snapshot_id": string }; Returns: {
              "snapshot_id": string,"status": string
            }[]
                           },
"fail_structure_analysis":
{ Args: { "p_analysis_id": string,"p_error_message": string }; Returns: {
              "analysis_id": string,"status": string
            }[]
                           },
"finish_ai_run":
{ Args: { "p_error_category": string,"p_error_message": string,"p_metrics": Json,"p_output": Json,"p_run_id": string,"p_status": string }; Returns: undefined
                           },
"finish_bug_scan":
{ Args: { "p_error": string,"p_scan_id": string,"p_status": string }; Returns: undefined
                           },
"generate_deadline_notifications":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"get_integration_ciphertext":
{ Args: { "p_integration_id": string }; Returns: string
                           },
"get_invitation_preview":
{ Args: { "p_token": string }; Returns: {
              "email_hint": string,"email_matches": boolean,"expires_at": string,"organization_name": string,"role": string,"status": string
            }[]
                           },
"has_org_role":
{ Args: { "p_org_id": string,"p_roles": (string)[] }; Returns: boolean
                           },
"health_check":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"import_organization_structure":
{ Args: { "p_apply": boolean,"p_kind": string,"p_organization_id": string,"p_rows": Json }; Returns: {
              "message": string,"name": string,"outcome": string,"row_number": number
            }[]
                           },
"import_workforce_directory":
{ Args: { "p_apply": boolean,"p_organization_id": string,"p_rows": Json }; Returns: {
              "email": string,"message": string,"outcome": string,"row_number": number
            }[]
                           },
"is_org_member":
{ Args: { "p_org_id": string }; Returns: boolean
                           },
"is_project_collaborator":
{ Args: { "p_project_id": string }; Returns: boolean
                           },
"list_bug_assignment_candidates":
{ Args: { "p_project_id": string }; Returns: {
              "availability": string,"display_name": string,"email": string,"job_title": string,"on_project_team": boolean,"open_bugs": number,"open_tasks": number,"role": string,"skills": (string)[],"team_id": string,"user_id": string
            }[]
                           },
"list_my_invitations":
{ Args: Record<PropertyKey, never>; Returns: {
              "expires_at": string,"invitation_id": string,"invited_by_name": string,"organization_name": string,"role": string
            }[]
                           },
"list_my_suspended_memberships":
{ Args: Record<PropertyKey, never>; Returns: {
              "organization_id": string,"organization_name": string,"suspended_at": string
            }[]
                           },
"mark_missing_jira_issues":
{ Args: { "p_integration_id": string,"p_seen_at": string }; Returns: number
                           },
"mark_notifications_read":
{ Args: { "p_ids": (string)[] }; Returns: number
                           },
"organization_workload":
{ Args: { "p_organization_id": string }; Returns: {
              "active_hours": number,"active_tasks": number,"blocked": number,"in_progress": number,"in_review": number,"overdue": number,"unestimated_tasks": number,"user_id": string
            }[]
                           },
"persist_snapshot_manifest":
{ Args: { "p_files": Json,"p_run_token": string,"p_signature": string,"p_snapshot_id": string,"p_source": Json }; Returns: {
              "files_count": number,"snapshot_id": string,"status": string
            }[]
                           },
"persist_structure_analysis":
{ Args: { "p_analysis_id": string,"p_files_analyzed": number,"p_files_failed": number,"p_files_total": number,"p_files_unsupported": number,"p_relationships": Json,"p_run_token": string,"p_signature": string,"p_symbols": Json }; Returns: {
              "id": string,"relationships_count": number,"status": string,"symbols_count": number
            }[]
                           },
"propose_bug_fix":
{ Args: { "p_bug_id": string,"p_diff": string,"p_edits": Json,"p_files": Json,"p_model": string,"p_plan": Json,"p_run_id": string }; Returns: string
                           },
"reactivate_organization_member":
{ Args: { "p_member_id": string }; Returns: undefined
                           },
"record_ai_run_state":
{ Args: { "p_detail": Json,"p_run_id": string,"p_state": string }; Returns: undefined
                           },
"record_bug_fix_validation":
{ Args: { "p_fix_id": string,"p_validation": Json }; Returns: undefined
                           },
"record_bug_scan_batch":
{ Args: { "p_batch_index": number,"p_cost_usd": number,"p_error": string,"p_failed": boolean,"p_findings": Json,"p_input_tokens": number,"p_output_tokens": number,"p_scan_id": string }; Returns: Json
                           },
"record_integration_result":
{ Args: { "p_integration_id": string,"p_message": string,"p_status": string,"p_sync_status": string }; Returns: undefined
                           },
"remove_organization_member":
{ Args: { "p_member_id": string }; Returns: undefined
                           },
"remove_project_team":
{ Args: { "p_project_id": string,"p_team_id": string }; Returns: undefined
                           },
"remove_task_dependency":
{ Args: { "p_depends_on": string,"p_task_id": string }; Returns: undefined
                           },
"remove_task_link":
{ Args: { "p_link_id": string }; Returns: undefined
                           },
"report_task_defect":
{ Args: { "p_details": string,"p_severity": string,"p_task_id": string,"p_title": string }; Returns: string
                           },
"report_unassignable_task":
{ Args: { "p_reason": string,"p_task_id": string }; Returns: undefined
                           },
"repository_code_search":
{ Args: { "p_limit"?: number,"p_query": string,"p_snapshot_id": string }; Returns: {
              "line": string,"line_number": number,"path": string
            }[]
                           },
"repository_graph_edges":
{ Args: { "p_analysis_id": string,"p_limit"?: number,"p_symbol_ids": (string)[],"p_types"?: (string)[] }; Returns: {
              "analysis_id": string,"id": string,"relationship_type": string,"source_symbol_id": string,"target_symbol_id": string,"total_relationships": number
            }[]
                           },
"repository_graph_overview":
{ Args: { "p_analysis_id": string }; Returns: {
              "external_relationships": number,"file_id": string,"path": string,"relationships": number,"symbols": number
            }[]
                           },
"repository_graph_search":
{ Args: { "p_analysis_id": string,"p_limit"?: number,"p_query": string }; Returns: {
              "file_id": string,"id": string,"kind": string,"name": string,"path": string,"qualified_name": string,"start_line": number,"total_matches": number
            }[]
                           },
"repository_graph_summary":
{ Args: { "p_analysis_id": string }; Returns: {
              "category": string,"name": string,"total": number
            }[]
                           },
"repository_graph_symbols":
{ Args: { "p_analysis_id": string,"p_file_id"?: string,"p_ids"?: (string)[],"p_limit"?: number }; Returns: {
              "analysis_id": string,"degree": number,"end_line": number,"file_id": string,"id": string,"kind": string,"name": string,"path": string,"qualified_name": string,"signature": string,"start_column": number,"start_line": number,"visibility": string
            }[]
                           },
"request_ai_run_cancel":
{ Args: { "p_run_id": string }; Returns: boolean
                           },
"reset_structure_analysis":
{ Args: { "p_analysis_id": string }; Returns: {
              "analysis_id": string,"status": string
            }[]
                           },
"resolve_task_defect":
{ Args: { "p_defect_id": string,"p_resolution": string }; Returns: undefined
                           },
"respond_task_handoff":
{ Args: { "p_accept": boolean,"p_handoff_id": string,"p_note": string,"p_take"?: boolean }; Returns: undefined
                           },
"resume_bug_scan":
{ Args: { "p_scan_id": string }; Returns: undefined
                           },
"revoke_organization_invitation":
{ Args: { "p_invitation_id": string }; Returns: undefined
                           },
"save_project_integration":
{ Args: { "p_ciphertext"?: string,"p_clear_credential"?: boolean,"p_jira_account_email"?: string,"p_jira_site"?: string,"p_kind": string,"p_project_id": string }; Returns: string
                           },
"select_jira_project":
{ Args: { "p_integration_id": string,"p_project_id": string,"p_project_key": string,"p_project_name": string }; Returns: undefined
                           },
"set_ai_enabled":
{ Args: { "p_enabled": boolean,"p_organization_id": string }; Returns: undefined
                           },
"set_assignment_mode":
{ Args: { "p_mode": string,"p_organization_id": string }; Returns: undefined
                           },
"set_task_required_skills":
{ Args: { "p_skill_ids": (string)[],"p_task_id": string }; Returns: undefined
                           },
"set_workforce_availability":
{ Args: { "p_availability": string,"p_profile_id": string }; Returns: undefined
                           },
"set_workforce_skills":
{ Args: { "p_profile_id": string,"p_skill_ids": (string)[] }; Returns: undefined
                           },
"shares_organization":
{ Args: { "p_user_id": string }; Returns: boolean
                           },
"slugify":
{ Args: { "p_fallback"?: string,"p_input": string }; Returns: string
                           },
"start_ai_run":
{ Args: { "p_input": Json,"p_job_type": string,"p_snapshot_id": string }; Returns: {
              "correlation_id": string,"run_id": string
            }[]
                           },
"start_bug_scan":
{ Args: { "p_files_planned": number,"p_files_total": number,"p_plan": Json,"p_snapshot_id": string }; Returns: string
                           },
"store_file_edges":
{ Args: { "p_edges": Json,"p_snapshot_id": string }; Returns: number
                           },
"store_snapshot_contents":
{ Args: { "p_files": Json,"p_snapshot_id": string }; Returns: {
              "already_stored": number,"stored": number
            }[]
                           },
"suspend_organization_member":
{ Args: { "p_member_id": string }; Returns: undefined
                           },
"task_assignment_candidates":
{ Args: { "p_task_id": string }; Returns: {
              "active_hours": number,"active_tasks": number,"availability": string,"display_name": string,"email": string,"in_project_team": boolean,"job_title": string,"matched_skills": number,"required_skills": number,"unestimated_tasks": number,"user_id": string
            }[]
                           },
"task_mention_candidates":
{ Args: { "p_task_id": string }; Returns: {
              "display_name": string,"user_id": string
            }[]
                           },
"transition_bug":
{ Args: { "p_bug_id": string,"p_note": string,"p_to": string }; Returns: undefined
                           },
"transition_task":
{ Args: { "p_reason"?: string,"p_status": string,"p_task_id": string }; Returns: undefined
                           },
"unassign_bug":
{ Args: { "p_bug_id": string,"p_reason": string }; Returns: undefined
                           },
"update_workforce_profile":
{ Args: { "p_clear_team"?: boolean,"p_department_id": string,"p_employee_code": string,"p_full_name": string,"p_job_title": string,"p_profile_id": string,"p_team_id": string }; Returns: undefined
                           },
"upsert_jira_issues":
{ Args: { "p_integration_id": string,"p_issues": Json,"p_seen_at": string }; Returns: {
              "inserted": number,"updated": number
            }[]
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const
