
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
            "department_members": {
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
                },"organization_members": {
                  Row: {
                    "created_at": string,"id": string,"organization_id": string,"role": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"organization_id": string,"role": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"organization_id"?: string,"role"?: string,"user_id"?: string
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
                    "archive_bytes": number,"archive_commit": string | null,"archive_format": string,"archive_sha256": string,"created_at": string,"entries_total": number,"files_accepted": number,"files_skipped": number,"files_skipped_generated": number | null,"files_skipped_metadata": number | null,"files_skipped_oversized": number | null,"snapshot_id": string,"source_kind": string,"uploaded_by": string | null,"verification": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archive_bytes": number,"archive_commit"?: string | null,"archive_format": string,"archive_sha256": string,"created_at"?: string,"entries_total": number,"files_accepted": number,"files_skipped": number,"files_skipped_generated"?: number | null,"files_skipped_metadata"?: number | null,"files_skipped_oversized"?: number | null,"snapshot_id": string,"source_kind": string,"uploaded_by"?: string | null,"verification"?: string
                  }
                  Update: {
                    "archive_bytes"?: number,"archive_commit"?: string | null,"archive_format"?: string,"archive_sha256"?: string,"created_at"?: string,"entries_total"?: number,"files_accepted"?: number,"files_skipped"?: number,"files_skipped_generated"?: number | null,"files_skipped_metadata"?: number | null,"files_skipped_oversized"?: number | null,"snapshot_id"?: string,"source_kind"?: string,"uploaded_by"?: string | null,"verification"?: string
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
                },"tasks": {
                  Row: {
                    "created_at": string,"created_by": string,"description": string | null,"id": string,"priority": string,"requirement_id": string,"status": string,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by": string,"description"?: string | null,"id"?: string,"priority"?: string,"requirement_id": string,"status"?: string,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string,"description"?: string | null,"id"?: string,"priority"?: string,"requirement_id"?: string,"status"?: string,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tasks_requirement_id_fkey"
      columns: ["requirement_id"]
isOneToOne: false
      referencedRelation: "requirements"
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
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
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
"create_team":
{ Args: { "p_department_id": string,"p_description"?: string,"p_name": string }; Returns: {
              "department_id": string,"description": string,"id": string,"name": string,"slug": string
            }[]
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
"has_org_role":
{ Args: { "p_org_id": string,"p_roles": (string)[] }; Returns: boolean
                           },
"is_org_member":
{ Args: { "p_org_id": string }; Returns: boolean
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
"reset_structure_analysis":
{ Args: { "p_analysis_id": string }; Returns: {
              "analysis_id": string,"status": string
            }[]
                           },
"slugify":
{ Args: { "p_fallback"?: string,"p_input": string }; Returns: string
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
