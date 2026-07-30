/**
 * Generated Supabase types — DO NOT EDIT BY HAND.
 *
 * Regenerate after every migration:
 *   pnpm db:types
 *
 * Checked in so CI can typecheck without a running database.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      psgc_barangays: {
        Row: {
          city_code: string
          code: string
          name: string
          old_name: string | null
          province_code: string | null
          region_code: string
          sub_municipality_code: string | null
        }
        Insert: {
          city_code: string
          code: string
          name: string
          old_name?: string | null
          province_code?: string | null
          region_code: string
          sub_municipality_code?: string | null
        }
        Update: {
          city_code?: string
          code?: string
          name?: string
          old_name?: string | null
          province_code?: string | null
          region_code?: string
          sub_municipality_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "psgc_barangays_city_code_fkey"
            columns: ["city_code"]
            isOneToOne: false
            referencedRelation: "psgc_address_units"
            referencedColumns: ["city_code"]
          },
          {
            foreignKeyName: "psgc_barangays_city_code_fkey"
            columns: ["city_code"]
            isOneToOne: false
            referencedRelation: "psgc_cities"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "psgc_barangays_province_code_fkey"
            columns: ["province_code"]
            isOneToOne: false
            referencedRelation: "psgc_address_units"
            referencedColumns: ["province_code"]
          },
          {
            foreignKeyName: "psgc_barangays_province_code_fkey"
            columns: ["province_code"]
            isOneToOne: false
            referencedRelation: "psgc_provinces"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "psgc_barangays_region_code_fkey"
            columns: ["region_code"]
            isOneToOne: false
            referencedRelation: "psgc_address_units"
            referencedColumns: ["region_code"]
          },
          {
            foreignKeyName: "psgc_barangays_region_code_fkey"
            columns: ["region_code"]
            isOneToOne: false
            referencedRelation: "psgc_regions"
            referencedColumns: ["code"]
          },
        ]
      }
      psgc_cities: {
        Row: {
          code: string
          display_name: string
          district_code: string | null
          is_capital: boolean
          is_city: boolean
          is_municipality: boolean
          island_group: string
          name: string
          old_name: string | null
          province_code: string | null
          region_code: string
        }
        Insert: {
          code: string
          display_name?: string
          district_code?: string | null
          is_capital?: boolean
          is_city?: boolean
          is_municipality?: boolean
          island_group: string
          name: string
          old_name?: string | null
          province_code?: string | null
          region_code: string
        }
        Update: {
          code?: string
          display_name?: string
          district_code?: string | null
          is_capital?: boolean
          is_city?: boolean
          is_municipality?: boolean
          island_group?: string
          name?: string
          old_name?: string | null
          province_code?: string | null
          region_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "psgc_cities_province_code_fkey"
            columns: ["province_code"]
            isOneToOne: false
            referencedRelation: "psgc_address_units"
            referencedColumns: ["province_code"]
          },
          {
            foreignKeyName: "psgc_cities_province_code_fkey"
            columns: ["province_code"]
            isOneToOne: false
            referencedRelation: "psgc_provinces"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "psgc_cities_region_code_fkey"
            columns: ["region_code"]
            isOneToOne: false
            referencedRelation: "psgc_address_units"
            referencedColumns: ["region_code"]
          },
          {
            foreignKeyName: "psgc_cities_region_code_fkey"
            columns: ["region_code"]
            isOneToOne: false
            referencedRelation: "psgc_regions"
            referencedColumns: ["code"]
          },
        ]
      }
      psgc_provinces: {
        Row: {
          code: string
          island_group: string
          name: string
          region_code: string
        }
        Insert: {
          code: string
          island_group: string
          name: string
          region_code: string
        }
        Update: {
          code?: string
          island_group?: string
          name?: string
          region_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "psgc_provinces_region_code_fkey"
            columns: ["region_code"]
            isOneToOne: false
            referencedRelation: "psgc_address_units"
            referencedColumns: ["region_code"]
          },
          {
            foreignKeyName: "psgc_provinces_region_code_fkey"
            columns: ["region_code"]
            isOneToOne: false
            referencedRelation: "psgc_regions"
            referencedColumns: ["code"]
          },
        ]
      }
      psgc_regions: {
        Row: {
          code: string
          island_group: string
          name: string
          region_name: string
        }
        Insert: {
          code: string
          island_group: string
          name: string
          region_name: string
        }
        Update: {
          code?: string
          island_group?: string
          name?: string
          region_name?: string
        }
        Relationships: []
      }
    }
    Views: {
      psgc_address_units: {
        Row: {
          barangay_code: string | null
          barangay_name: string | null
          city_code: string | null
          city_display_name: string | null
          city_name: string | null
          full_path: string | null
          is_city: boolean | null
          island_group: string | null
          province_code: string | null
          province_name: string | null
          region_code: string | null
          region_name: string | null
          region_numeral: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

