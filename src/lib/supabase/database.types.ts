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
      categories: {
        Row: {
          created_at: string
          id: string
          name: string
          parent_id: string | null
          slug: string
          sort_order: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          parent_id?: string | null
          slug: string
          sort_order?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          parent_id?: string | null
          slug?: string
          sort_order?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "categories_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "categories_tenant_id_parent_id_fkey"
            columns: ["tenant_id", "parent_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      inventory_levels: {
        Row: {
          created_at: string
          id: string
          incoming: number
          location_id: string
          low_stock_threshold: number | null
          on_hand: number
          reserved: number
          tenant_id: string
          updated_at: string
          variant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          incoming?: number
          location_id: string
          low_stock_threshold?: number | null
          on_hand?: number
          reserved?: number
          tenant_id: string
          updated_at?: string
          variant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          incoming?: number
          location_id?: string
          low_stock_threshold?: number | null
          on_hand?: number
          reserved?: number
          tenant_id?: string
          updated_at?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_levels_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_tenant_id_location_id_fkey"
            columns: ["tenant_id", "location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "inventory_levels_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "inventory_levels_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_availability"
            referencedColumns: ["tenant_id", "variant_id"]
          },
          {
            foreignKeyName: "inventory_levels_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_variants"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      invitations: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          role: Database["public"]["Enums"]["tenant_role"]
          tenant_id: string
          token: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          role?: Database["public"]["Enums"]["tenant_role"]
          tenant_id: string
          token?: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          role?: Database["public"]["Enums"]["tenant_role"]
          tenant_id?: string
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          barangay_code: string | null
          city_code: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          id: string
          is_default: boolean
          landmark: string | null
          name: string
          postal_code: string | null
          province_code: string | null
          region_code: string | null
          street: string | null
          tenant_id: string
          type: string
          updated_at: string
        }
        Insert: {
          barangay_code?: string | null
          city_code?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          landmark?: string | null
          name: string
          postal_code?: string | null
          province_code?: string | null
          region_code?: string | null
          street?: string | null
          tenant_id: string
          type?: string
          updated_at?: string
        }
        Update: {
          barangay_code?: string | null
          city_code?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          landmark?: string | null
          name?: string
          postal_code?: string | null
          province_code?: string | null
          region_code?: string | null
          street?: string | null
          tenant_id?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "locations_barangay_code_fkey"
            columns: ["barangay_code"]
            isOneToOne: false
            referencedRelation: "psgc_address_units"
            referencedColumns: ["barangay_code"]
          },
          {
            foreignKeyName: "locations_barangay_code_fkey"
            columns: ["barangay_code"]
            isOneToOne: false
            referencedRelation: "psgc_barangays"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "locations_city_code_fkey"
            columns: ["city_code"]
            isOneToOne: false
            referencedRelation: "psgc_address_units"
            referencedColumns: ["city_code"]
          },
          {
            foreignKeyName: "locations_city_code_fkey"
            columns: ["city_code"]
            isOneToOne: false
            referencedRelation: "psgc_cities"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "locations_province_code_fkey"
            columns: ["province_code"]
            isOneToOne: false
            referencedRelation: "psgc_address_units"
            referencedColumns: ["province_code"]
          },
          {
            foreignKeyName: "locations_province_code_fkey"
            columns: ["province_code"]
            isOneToOne: false
            referencedRelation: "psgc_provinces"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "locations_region_code_fkey"
            columns: ["region_code"]
            isOneToOne: false
            referencedRelation: "psgc_address_units"
            referencedColumns: ["region_code"]
          },
          {
            foreignKeyName: "locations_region_code_fkey"
            columns: ["region_code"]
            isOneToOne: false
            referencedRelation: "psgc_regions"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "locations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "locations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      media_assets: {
        Row: {
          created_at: string
          height: number | null
          id: string
          mime: string
          size_bytes: number
          storage_path: string
          tenant_id: string
          width: number | null
        }
        Insert: {
          created_at?: string
          height?: number | null
          id?: string
          mime: string
          size_bytes: number
          storage_path: string
          tenant_id: string
          width?: number | null
        }
        Update: {
          created_at?: string
          height?: number | null
          id?: string
          mime?: string
          size_bytes?: number
          storage_path?: string
          tenant_id?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "media_assets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_assets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      product_images: {
        Row: {
          alt: string | null
          created_at: string
          id: string
          product_id: string
          sort_order: number
          storage_path: string
          tenant_id: string
          variant_id: string | null
        }
        Insert: {
          alt?: string | null
          created_at?: string
          id?: string
          product_id: string
          sort_order?: number
          storage_path: string
          tenant_id: string
          variant_id?: string | null
        }
        Update: {
          alt?: string | null
          created_at?: string
          id?: string
          product_id?: string
          sort_order?: number
          storage_path?: string
          tenant_id?: string
          variant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_images_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_images_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_images_tenant_id_product_id_fkey"
            columns: ["tenant_id", "product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "product_images_tenant_id_product_id_fkey"
            columns: ["tenant_id", "product_id"]
            isOneToOne: false
            referencedRelation: "storefront_products"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "product_images_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "product_images_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_availability"
            referencedColumns: ["tenant_id", "variant_id"]
          },
          {
            foreignKeyName: "product_images_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_variants"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      product_option_values: {
        Row: {
          created_at: string
          id: string
          option_id: string
          sort_order: number
          tenant_id: string
          value: string
        }
        Insert: {
          created_at?: string
          id?: string
          option_id: string
          sort_order?: number
          tenant_id: string
          value: string
        }
        Update: {
          created_at?: string
          id?: string
          option_id?: string
          sort_order?: number
          tenant_id?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_option_values_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_option_values_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_option_values_tenant_id_option_id_fkey"
            columns: ["tenant_id", "option_id"]
            isOneToOne: false
            referencedRelation: "product_options"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      product_options: {
        Row: {
          created_at: string
          id: string
          name: string
          product_id: string
          sort_order: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          product_id: string
          sort_order?: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          product_id?: string
          sort_order?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_options_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_options_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_options_tenant_id_product_id_fkey"
            columns: ["tenant_id", "product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "product_options_tenant_id_product_id_fkey"
            columns: ["tenant_id", "product_id"]
            isOneToOne: false
            referencedRelation: "storefront_products"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      product_variants: {
        Row: {
          barcode: string | null
          compare_at_price_centavos: number | null
          cost_centavos: number | null
          created_at: string
          id: string
          option_value_ids: string[]
          position: number
          price_centavos: number
          product_id: string
          sku: string | null
          tenant_id: string
          updated_at: string
          weight_grams: number | null
        }
        Insert: {
          barcode?: string | null
          compare_at_price_centavos?: number | null
          cost_centavos?: number | null
          created_at?: string
          id?: string
          option_value_ids?: string[]
          position?: number
          price_centavos?: number
          product_id: string
          sku?: string | null
          tenant_id: string
          updated_at?: string
          weight_grams?: number | null
        }
        Update: {
          barcode?: string | null
          compare_at_price_centavos?: number | null
          cost_centavos?: number | null
          created_at?: string
          id?: string
          option_value_ids?: string[]
          position?: number
          price_centavos?: number
          product_id?: string
          sku?: string | null
          tenant_id?: string
          updated_at?: string
          weight_grams?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "product_variants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_variants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_variants_tenant_id_product_id_fkey"
            columns: ["tenant_id", "product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "product_variants_tenant_id_product_id_fkey"
            columns: ["tenant_id", "product_id"]
            isOneToOne: false
            referencedRelation: "storefront_products"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      products: {
        Row: {
          category_id: string | null
          created_at: string
          description: string | null
          height_cm: number | null
          id: string
          is_cod_allowed: boolean
          length_cm: number | null
          name: string
          slug: string
          status: string
          tenant_id: string
          updated_at: string
          weight_grams: number | null
          width_cm: number | null
        }
        Insert: {
          category_id?: string | null
          created_at?: string
          description?: string | null
          height_cm?: number | null
          id?: string
          is_cod_allowed?: boolean
          length_cm?: number | null
          name: string
          slug: string
          status?: string
          tenant_id: string
          updated_at?: string
          weight_grams?: number | null
          width_cm?: number | null
        }
        Update: {
          category_id?: string | null
          created_at?: string
          description?: string | null
          height_cm?: number | null
          id?: string
          is_cod_allowed?: boolean
          length_cm?: number | null
          name?: string
          slug?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          weight_grams?: number | null
          width_cm?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "products_tenant_id_category_id_fkey"
            columns: ["tenant_id", "category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_path: string | null
          created_at: string
          full_name: string | null
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          avatar_path?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_path?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
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
      stock_movements: {
        Row: {
          created_at: string
          created_by: string | null
          delta: number
          id: string
          location_id: string
          note: string | null
          reason: string
          reference_id: string | null
          reference_type: string | null
          tenant_id: string
          variant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          delta: number
          id?: string
          location_id: string
          note?: string | null
          reason: string
          reference_id?: string | null
          reference_type?: string | null
          tenant_id: string
          variant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          delta?: number
          id?: string
          location_id?: string
          note?: string | null
          reason?: string
          reference_id?: string | null
          reference_type?: string | null
          tenant_id?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_movements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_tenant_id_location_id_fkey"
            columns: ["tenant_id", "location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "stock_movements_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "stock_movements_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_availability"
            referencedColumns: ["tenant_id", "variant_id"]
          },
          {
            foreignKeyName: "stock_movements_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_variants"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      storefront_themes: {
        Row: {
          colors: Json
          created_at: string
          custom_css: string | null
          fonts: Json
          hero: Json
          preset: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          colors?: Json
          created_at?: string
          custom_css?: string | null
          fonts?: Json
          hero?: Json
          preset?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          colors?: Json
          created_at?: string
          custom_css?: string | null
          fonts?: Json
          hero?: Json
          preset?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "storefront_themes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storefront_themes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_members: {
        Row: {
          accepted_at: string | null
          created_at: string
          id: string
          invited_at: string | null
          role: Database["public"]["Enums"]["tenant_role"]
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          id?: string
          invited_at?: string | null
          role?: Database["public"]["Enums"]["tenant_role"]
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          id?: string
          invited_at?: string | null
          role?: Database["public"]["Enums"]["tenant_role"]
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_members_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_members_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_settings: {
        Row: {
          key: string
          tenant_id: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          tenant_id: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          tenant_id?: string
          updated_at?: string
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "tenant_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          brand_color: string | null
          created_at: string
          custom_domain: string | null
          id: string
          locale: string
          logo_path: string | null
          name: string
          slug: string
          status: string
          timezone: string
          updated_at: string
        }
        Insert: {
          brand_color?: string | null
          created_at?: string
          custom_domain?: string | null
          id?: string
          locale?: string
          logo_path?: string | null
          name: string
          slug: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          brand_color?: string | null
          created_at?: string
          custom_domain?: string | null
          id?: string
          locale?: string
          logo_path?: string | null
          name?: string
          slug?: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      inventory_overview: {
        Row: {
          available: number | null
          id: string | null
          incoming: number | null
          is_low: boolean | null
          location_id: string | null
          location_name: string | null
          low_stock_threshold: number | null
          on_hand: number | null
          price_centavos: number | null
          product_id: string | null
          product_name: string | null
          reserved: number | null
          sku: string | null
          tenant_id: string | null
          updated_at: string | null
          variant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_levels_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_tenant_id_location_id_fkey"
            columns: ["tenant_id", "location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "inventory_levels_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "inventory_levels_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_availability"
            referencedColumns: ["tenant_id", "variant_id"]
          },
          {
            foreignKeyName: "inventory_levels_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_variants"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
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
      storefront_availability: {
        Row: {
          in_stock: boolean | null
          product_id: string | null
          stock_state: string | null
          tenant_id: string | null
          variant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_variants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_variants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_variants_tenant_id_product_id_fkey"
            columns: ["tenant_id", "product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "product_variants_tenant_id_product_id_fkey"
            columns: ["tenant_id", "product_id"]
            isOneToOne: false
            referencedRelation: "storefront_products"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      storefront_product_images: {
        Row: {
          alt: string | null
          id: string | null
          product_id: string | null
          sort_order: number | null
          storage_path: string | null
          variant_id: string | null
        }
        Relationships: []
      }
      storefront_products: {
        Row: {
          category_name: string | null
          category_slug: string | null
          created_at: string | null
          description: string | null
          id: string | null
          is_cod_allowed: boolean | null
          name: string | null
          slug: string | null
          store_slug: string | null
          tenant_id: string | null
          weight_grams: number | null
        }
        Relationships: [
          {
            foreignKeyName: "products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      storefront_tenants: {
        Row: {
          brand_color: string | null
          custom_domain: string | null
          id: string | null
          locale: string | null
          logo_path: string | null
          name: string | null
          slug: string | null
        }
        Insert: {
          brand_color?: string | null
          custom_domain?: string | null
          id?: string | null
          locale?: string | null
          logo_path?: string | null
          name?: string | null
          slug?: string | null
        }
        Update: {
          brand_color?: string | null
          custom_domain?: string | null
          id?: string | null
          locale?: string | null
          logo_path?: string | null
          name?: string | null
          slug?: string | null
        }
        Relationships: []
      }
      storefront_theme_public: {
        Row: {
          colors: Json | null
          custom_css: string | null
          fonts: Json | null
          hero: Json | null
          preset: string | null
          slug: string | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "storefront_themes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storefront_themes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      storefront_variants: {
        Row: {
          compare_at_price_centavos: number | null
          id: string | null
          option_value_ids: string[] | null
          position: number | null
          price_centavos: number | null
          product_id: string | null
          sku: string | null
          tenant_id: string | null
          weight_grams: number | null
        }
        Relationships: [
          {
            foreignKeyName: "product_variants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_variants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_variants_tenant_id_product_id_fkey"
            columns: ["tenant_id", "product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "product_variants_tenant_id_product_id_fkey"
            columns: ["tenant_id", "product_id"]
            isOneToOne: false
            referencedRelation: "storefront_products"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
    }
    Functions: {
      accept_invitation: {
        Args: { p_token: string }
        Returns: {
          accepted_at: string | null
          created_at: string
          id: string
          invited_at: string | null
          role: Database["public"]["Enums"]["tenant_role"]
          tenant_id: string
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "tenant_members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      assert_variant_options_valid: {
        Args: { p_variant_id: string }
        Returns: undefined
      }
      available_stock: {
        Args: { p_on_hand: number; p_reserved: number }
        Returns: number
      }
      catalog_slugify: { Args: { p_text: string }; Returns: string }
      create_tenant: {
        Args: { p_name: string; p_slug: string }
        Returns: {
          brand_color: string | null
          created_at: string
          custom_domain: string | null
          id: string
          locale: string
          logo_path: string | null
          name: string
          slug: string
          status: string
          timezone: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "tenants"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_tenant_id: { Args: never; Returns: string }
      has_tenant_role: {
        Args: {
          p_min_role: Database["public"]["Enums"]["tenant_role"]
          p_tenant_id: string
        }
        Returns: boolean
      }
      is_reserved_tenant_slug: { Args: { slug: string }; Returns: boolean }
      is_tenant_member: { Args: { p_tenant_id: string }; Returns: boolean }
      is_valid_tenant_slug: { Args: { slug: string }; Returns: boolean }
      my_tenants: {
        Args: never
        Returns: {
          brand_color: string
          id: string
          joined_at: string
          logo_path: string
          name: string
          role: Database["public"]["Enums"]["tenant_role"]
          slug: string
          status: string
        }[]
      }
      record_stock_movement: {
        Args: {
          p_delta: number
          p_location_id: string
          p_note?: string
          p_reason: string
          p_reference_id?: string
          p_reference_type?: string
          p_tenant_id: string
          p_variant_id: string
        }
        Returns: string
      }
      release_reservation: {
        Args: { p_items: Json; p_location_id: string; p_tenant_id: string }
        Returns: undefined
      }
      reserve_stock: {
        Args: {
          p_items: Json
          p_location_id: string
          p_reference_id?: string
          p_reference_type?: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      seed_categories_from_presets: {
        Args: { p_names: string[]; p_tenant_id: string }
        Returns: number
      }
      set_stock_level: {
        Args: {
          p_location_id: string
          p_note?: string
          p_on_hand: number
          p_tenant_id: string
          p_variant_id: string
        }
        Returns: undefined
      }
      ship_reservation: {
        Args: {
          p_items: Json
          p_location_id: string
          p_reference_id?: string
          p_reference_type?: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      storage_path_tenant_id: { Args: { p_name: string }; Returns: string }
      tenant_role_of: {
        Args: { p_tenant_id: string }
        Returns: Database["public"]["Enums"]["tenant_role"]
      }
      tenant_role_rank: {
        Args: { role: Database["public"]["Enums"]["tenant_role"] }
        Returns: number
      }
    }
    Enums: {
      tenant_role: "owner" | "admin" | "staff" | "packer" | "rider"
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
    Enums: {
      tenant_role: ["owner", "admin", "staff", "packer", "rider"],
    },
  },
} as const

