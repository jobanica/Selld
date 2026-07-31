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
      auto_replies: {
        Row: {
          body: string
          channel: string
          created_at: string
          id: string
          is_active: boolean
          keyword: string
          match_type: string
          priority: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          body: string
          channel?: string
          created_at?: string
          id?: string
          is_active?: boolean
          keyword: string
          match_type?: string
          priority?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          body?: string
          channel?: string
          created_at?: string
          id?: string
          is_active?: boolean
          keyword?: string
          match_type?: string
          priority?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "auto_replies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auto_replies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      buyer_risk_contributions: {
        Row: {
          delivered_count: number
          orders_count: number
          phone_hash: string
          rts_count: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          delivered_count?: number
          orders_count?: number
          phone_hash: string
          rts_count?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          delivered_count?: number
          orders_count?: number
          phone_hash?: string
          rts_count?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "buyer_risk_contributions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buyer_risk_contributions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      buyer_risk_flags: {
        Row: {
          block_cod: boolean
          delivered_count: number
          id: string
          last_rts_at: string | null
          note: string | null
          orders_count: number
          phone_digits: string
          rts_count: number
          rts_rate_bps: number
          tenant_id: string
          trusted: boolean
          updated_at: string
        }
        Insert: {
          block_cod?: boolean
          delivered_count?: number
          id?: string
          last_rts_at?: string | null
          note?: string | null
          orders_count?: number
          phone_digits: string
          rts_count?: number
          rts_rate_bps?: number
          tenant_id: string
          trusted?: boolean
          updated_at?: string
        }
        Update: {
          block_cod?: boolean
          delivered_count?: number
          id?: string
          last_rts_at?: string | null
          note?: string | null
          orders_count?: number
          phone_digits?: string
          rts_count?: number
          rts_rate_bps?: number
          tenant_id?: string
          trusted?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "buyer_risk_flags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buyer_risk_flags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      buyer_risk_signals: {
        Row: {
          delivered_count: number
          first_seen_at: string
          orders_count: number
          phone_hash: string
          rts_count: number
          tenants_seen: number
          updated_at: string
        }
        Insert: {
          delivered_count?: number
          first_seen_at?: string
          orders_count?: number
          phone_hash: string
          rts_count?: number
          tenants_seen?: number
          updated_at?: string
        }
        Update: {
          delivered_count?: number
          first_seen_at?: string
          orders_count?: number
          phone_hash?: string
          rts_count?: number
          tenants_seen?: number
          updated_at?: string
        }
        Relationships: []
      }
      cart_items: {
        Row: {
          cart_id: string
          created_at: string
          id: string
          qty: number
          tenant_id: string
          unit_price_centavos: number
          updated_at: string
          variant_id: string
        }
        Insert: {
          cart_id: string
          created_at?: string
          id?: string
          qty: number
          tenant_id: string
          unit_price_centavos: number
          updated_at?: string
          variant_id: string
        }
        Update: {
          cart_id?: string
          created_at?: string
          id?: string
          qty?: number
          tenant_id?: string
          unit_price_centavos?: number
          updated_at?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cart_items_tenant_id_cart_id_fkey"
            columns: ["tenant_id", "cart_id"]
            isOneToOne: false
            referencedRelation: "carts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "cart_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cart_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cart_items_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "cart_items_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_availability"
            referencedColumns: ["tenant_id", "variant_id"]
          },
          {
            foreignKeyName: "cart_items_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_variants"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      carts: {
        Row: {
          created_at: string
          customer_id: string | null
          expires_at: string
          id: string
          source: string
          status: string
          tenant_id: string
          token: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_id?: string | null
          expires_at?: string
          id?: string
          source?: string
          status?: string
          tenant_id: string
          token: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_id?: string | null
          expires_at?: string
          id?: string
          source?: string
          status?: string
          tenant_id?: string
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "carts_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "carts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "carts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
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
      cod_remittance_lines: {
        Row: {
          amount_centavos: number
          created_at: string
          fee_centavos: number
          id: string
          match_status: string
          order_id: string | null
          raw: Json | null
          remittance_id: string
          remitted_at: string | null
          row_number: number
          shipment_id: string | null
          tenant_id: string
          variance_centavos: number
          waybill: string
        }
        Insert: {
          amount_centavos: number
          created_at?: string
          fee_centavos?: number
          id?: string
          match_status: string
          order_id?: string | null
          raw?: Json | null
          remittance_id: string
          remitted_at?: string | null
          row_number: number
          shipment_id?: string | null
          tenant_id: string
          variance_centavos?: number
          waybill: string
        }
        Update: {
          amount_centavos?: number
          created_at?: string
          fee_centavos?: number
          id?: string
          match_status?: string
          order_id?: string | null
          raw?: Json | null
          remittance_id?: string
          remitted_at?: string | null
          row_number?: number
          shipment_id?: string | null
          tenant_id?: string
          variance_centavos?: number
          waybill?: string
        }
        Relationships: [
          {
            foreignKeyName: "cod_remittance_lines_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cod_remittance_lines_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cod_remittance_lines_tenant_id_order_id_fkey"
            columns: ["tenant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "cod_remittance_lines_tenant_id_remittance_id_fkey"
            columns: ["tenant_id", "remittance_id"]
            isOneToOne: false
            referencedRelation: "cod_remittances"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "cod_remittance_lines_tenant_id_shipment_id_fkey"
            columns: ["tenant_id", "shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      cod_remittances: {
        Row: {
          courier: string
          created_at: string
          declared_total_centavos: number | null
          filename: string | null
          id: string
          imported_by: string | null
          period_end: string | null
          period_start: string | null
          posted_at: string | null
          posted_by: string | null
          reference: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          courier: string
          created_at?: string
          declared_total_centavos?: number | null
          filename?: string | null
          id?: string
          imported_by?: string | null
          period_end?: string | null
          period_start?: string | null
          posted_at?: string | null
          posted_by?: string | null
          reference?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          courier?: string
          created_at?: string
          declared_total_centavos?: number | null
          filename?: string | null
          id?: string
          imported_by?: string | null
          period_end?: string | null
          period_start?: string | null
          posted_at?: string | null
          posted_by?: string | null
          reference?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cod_remittances_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cod_remittances_posted_by_fkey"
            columns: ["posted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cod_remittances_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cod_remittances_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      courier_accounts: {
        Row: {
          account_ref: string | null
          connected_at: string | null
          courier: string
          created_at: string
          credentials_encrypted: string | null
          id: string
          is_enabled: boolean
          is_live: boolean
          origin_address: Json | null
          sender_name: string | null
          sender_phone: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          account_ref?: string | null
          connected_at?: string | null
          courier: string
          created_at?: string
          credentials_encrypted?: string | null
          id?: string
          is_enabled?: boolean
          is_live?: boolean
          origin_address?: Json | null
          sender_name?: string | null
          sender_phone?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          account_ref?: string | null
          connected_at?: string | null
          courier?: string
          created_at?: string
          credentials_encrypted?: string | null
          id?: string
          is_enabled?: boolean
          is_live?: boolean
          origin_address?: Json | null
          sender_name?: string | null
          sender_phone?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "courier_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "courier_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      courier_booking_failures: {
        Row: {
          attempts: number
          courier: string
          created_at: string
          error_code: string | null
          error_message: string
          id: string
          kind: string
          next_retry_at: string | null
          order_id: string
          resolved_at: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          courier: string
          created_at?: string
          error_code?: string | null
          error_message: string
          id?: string
          kind: string
          next_retry_at?: string | null
          order_id: string
          resolved_at?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          courier?: string
          created_at?: string
          error_code?: string | null
          error_message?: string
          id?: string
          kind?: string
          next_retry_at?: string | null
          order_id?: string
          resolved_at?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "courier_booking_failures_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "courier_booking_failures_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "courier_booking_failures_tenant_id_order_id_fkey"
            columns: ["tenant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      customers: {
        Row: {
          created_at: string
          email: string | null
          fb_psid: string | null
          id: string
          name: string
          notes: string | null
          phone: string
          source: string
          tenant_id: string
          total_orders: number
          total_spent_centavos: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          fb_psid?: string | null
          id?: string
          name: string
          notes?: string | null
          phone: string
          source?: string
          tenant_id: string
          total_orders?: number
          total_spent_centavos?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          fb_psid?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string
          source?: string
          tenant_id?: string
          total_orders?: number
          total_spent_centavos?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_logs: {
        Row: {
          attempt: number
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_message: string | null
          http_status: number | null
          id: string
          idempotency_key: string
          operation: string
          provider: string
          request: Json | null
          response: Json | null
          status: string
          tenant_id: string
        }
        Insert: {
          attempt?: number
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_message?: string | null
          http_status?: number | null
          id?: string
          idempotency_key: string
          operation: string
          provider: string
          request?: Json | null
          response?: Json | null
          status: string
          tenant_id: string
        }
        Update: {
          attempt?: number
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_message?: string | null
          http_status?: number | null
          id?: string
          idempotency_key?: string
          operation?: string
          provider?: string
          request?: Json | null
          response?: Json | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integration_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
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
      live_claims: {
        Row: {
          buyer_name: string | null
          cart_id: string | null
          comment_id: string | null
          created_at: string
          expires_at: string
          id: string
          item_id: string
          order_id: string | null
          psid: string
          qty: number
          session_id: string
          settled_at: string | null
          status: string
          tenant_id: string
        }
        Insert: {
          buyer_name?: string | null
          cart_id?: string | null
          comment_id?: string | null
          created_at?: string
          expires_at: string
          id?: string
          item_id: string
          order_id?: string | null
          psid: string
          qty: number
          session_id: string
          settled_at?: string | null
          status?: string
          tenant_id: string
        }
        Update: {
          buyer_name?: string | null
          cart_id?: string | null
          comment_id?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          item_id?: string
          order_id?: string | null
          psid?: string
          qty?: number
          session_id?: string
          settled_at?: string | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_claims_tenant_id_comment_id_fkey"
            columns: ["tenant_id", "comment_id"]
            isOneToOne: false
            referencedRelation: "live_comments"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "live_claims_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_claims_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_claims_tenant_id_item_id_fkey"
            columns: ["tenant_id", "item_id"]
            isOneToOne: false
            referencedRelation: "live_items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "live_claims_tenant_id_order_id_fkey"
            columns: ["tenant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "live_claims_tenant_id_session_id_fkey"
            columns: ["tenant_id", "session_id"]
            isOneToOne: false
            referencedRelation: "live_sessions"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      live_comments: {
        Row: {
          author_name: string | null
          body: string
          external_id: string
          id: string
          outcome: string
          parsed: Json | null
          psid: string
          received_at: string
          session_id: string
          tenant_id: string
        }
        Insert: {
          author_name?: string | null
          body: string
          external_id: string
          id?: string
          outcome?: string
          parsed?: Json | null
          psid: string
          received_at?: string
          session_id: string
          tenant_id: string
        }
        Update: {
          author_name?: string | null
          body?: string
          external_id?: string
          id?: string
          outcome?: string
          parsed?: Json | null
          psid?: string
          received_at?: string
          session_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_comments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_comments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_comments_tenant_id_session_id_fkey"
            columns: ["tenant_id", "session_id"]
            isOneToOne: false
            referencedRelation: "live_sessions"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      live_items: {
        Row: {
          allocated_qty: number | null
          claim_code: string
          created_at: string
          id: string
          session_id: string
          sort_order: number
          tenant_id: string
          variant_id: string
        }
        Insert: {
          allocated_qty?: number | null
          claim_code: string
          created_at?: string
          id?: string
          session_id: string
          sort_order?: number
          tenant_id: string
          variant_id: string
        }
        Update: {
          allocated_qty?: number | null
          claim_code?: string
          created_at?: string
          id?: string
          session_id?: string
          sort_order?: number
          tenant_id?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_items_tenant_id_session_id_fkey"
            columns: ["tenant_id", "session_id"]
            isOneToOne: false
            referencedRelation: "live_sessions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "live_items_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "live_items_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_availability"
            referencedColumns: ["tenant_id", "variant_id"]
          },
          {
            foreignKeyName: "live_items_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_variants"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      live_sessions: {
        Row: {
          channel: string
          claim_window_minutes: number
          created_at: string
          created_by: string | null
          current_item_id: string | null
          ended_at: string | null
          external_ref: string | null
          id: string
          location_id: string | null
          started_at: string | null
          status: string
          tenant_id: string
          title: string
          updated_at: string
        }
        Insert: {
          channel?: string
          claim_window_minutes?: number
          created_at?: string
          created_by?: string | null
          current_item_id?: string | null
          ended_at?: string | null
          external_ref?: string | null
          id?: string
          location_id?: string | null
          started_at?: string | null
          status?: string
          tenant_id: string
          title: string
          updated_at?: string
        }
        Update: {
          channel?: string
          claim_window_minutes?: number
          created_at?: string
          created_by?: string | null
          current_item_id?: string | null
          ended_at?: string | null
          external_ref?: string | null
          id?: string
          location_id?: string | null
          started_at?: string | null
          status?: string
          tenant_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_sessions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_sessions_current_item_fkey"
            columns: ["tenant_id", "current_item_id"]
            isOneToOne: false
            referencedRelation: "live_items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "live_sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_sessions_tenant_id_location_id_fkey"
            columns: ["tenant_id", "location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["tenant_id", "id"]
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
      message_tags: {
        Row: {
          automation_allowed: boolean
          description: string
          tag: string
          window_hours: number | null
        }
        Insert: {
          automation_allowed?: boolean
          description: string
          tag: string
          window_hours?: number | null
        }
        Update: {
          automation_allowed?: boolean
          description?: string
          tag?: string
          window_hours?: number | null
        }
        Relationships: []
      }
      message_threads: {
        Row: {
          created_at: string
          customer_id: string | null
          id: string
          last_inbound_at: string | null
          last_message_at: string | null
          last_outbound_at: string | null
          last_snippet: string | null
          participant_name: string | null
          platform: string
          psid: string
          social_account_id: string
          status: string
          tenant_id: string
          unread_count: number
        }
        Insert: {
          created_at?: string
          customer_id?: string | null
          id?: string
          last_inbound_at?: string | null
          last_message_at?: string | null
          last_outbound_at?: string | null
          last_snippet?: string | null
          participant_name?: string | null
          platform: string
          psid: string
          social_account_id: string
          status?: string
          tenant_id: string
          unread_count?: number
        }
        Update: {
          created_at?: string
          customer_id?: string | null
          id?: string
          last_inbound_at?: string | null
          last_message_at?: string | null
          last_outbound_at?: string | null
          last_snippet?: string | null
          participant_name?: string | null
          platform?: string
          psid?: string
          social_account_id?: string
          status?: string
          tenant_id?: string
          unread_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "message_threads_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "message_threads_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_threads_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_threads_tenant_id_social_account_id_fkey"
            columns: ["tenant_id", "social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "message_threads_tenant_id_social_account_id_fkey"
            columns: ["tenant_id", "social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts_safe"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      messages: {
        Row: {
          attachments: Json | null
          body: string | null
          created_at: string
          direction: string
          error: string | null
          external_id: string | null
          id: string
          sent_at: string
          source: string
          status: string
          tag: string | null
          tenant_id: string
          thread_id: string
        }
        Insert: {
          attachments?: Json | null
          body?: string | null
          created_at?: string
          direction: string
          error?: string | null
          external_id?: string | null
          id?: string
          sent_at?: string
          source?: string
          status?: string
          tag?: string | null
          tenant_id: string
          thread_id: string
        }
        Update: {
          attachments?: Json | null
          body?: string | null
          created_at?: string
          direction?: string
          error?: string | null
          external_id?: string | null
          id?: string
          sent_at?: string
          source?: string
          status?: string
          tag?: string | null
          tenant_id?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_tenant_id_thread_id_fkey"
            columns: ["tenant_id", "thread_id"]
            isOneToOne: false
            referencedRelation: "message_threads"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      order_counters: {
        Row: {
          next_number: number
          tenant_id: string
        }
        Insert: {
          next_number?: number
          tenant_id: string
        }
        Update: {
          next_number?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_counters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_counters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          cost_centavos: number | null
          created_at: string
          id: string
          line_total_centavos: number
          order_id: string
          product_name: string
          qty: number
          sku: string | null
          tenant_id: string
          unit_price_centavos: number
          variant_id: string | null
          variant_label: string | null
        }
        Insert: {
          cost_centavos?: number | null
          created_at?: string
          id?: string
          line_total_centavos: number
          order_id: string
          product_name: string
          qty: number
          sku?: string | null
          tenant_id: string
          unit_price_centavos: number
          variant_id?: string | null
          variant_label?: string | null
        }
        Update: {
          cost_centavos?: number | null
          created_at?: string
          id?: string
          line_total_centavos?: number
          order_id?: string
          product_name?: string
          qty?: number
          sku?: string | null
          tenant_id?: string
          unit_price_centavos?: number
          variant_id?: string | null
          variant_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_tenant_id_order_id_fkey"
            columns: ["tenant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "order_items_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "order_items_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_availability"
            referencedColumns: ["tenant_id", "variant_id"]
          },
          {
            foreignKeyName: "order_items_tenant_id_variant_id_fkey"
            columns: ["tenant_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "storefront_variants"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      order_notes: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          id: string
          order_id: string
          tenant_id: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          id?: string
          order_id: string
          tenant_id: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          id?: string
          order_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_notes_tenant_id_order_id_fkey"
            columns: ["tenant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      order_rts: {
        Row: {
          created_at: string
          id: string
          location_id: string | null
          note: string | null
          order_id: string
          outbound_cost_centavos: number
          reason: string
          recorded_by: string | null
          restocked: boolean
          return_cost_centavos: number
          shipment_id: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          location_id?: string | null
          note?: string | null
          order_id: string
          outbound_cost_centavos?: number
          reason: string
          recorded_by?: string | null
          restocked?: boolean
          return_cost_centavos?: number
          shipment_id?: string | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          location_id?: string | null
          note?: string | null
          order_id?: string
          outbound_cost_centavos?: number
          reason?: string
          recorded_by?: string | null
          restocked?: boolean
          return_cost_centavos?: number
          shipment_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_rts_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_rts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_rts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_rts_tenant_id_location_id_fkey"
            columns: ["tenant_id", "location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "order_rts_tenant_id_order_id_fkey"
            columns: ["tenant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "order_rts_tenant_id_shipment_id_fkey"
            columns: ["tenant_id", "shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      order_status_history: {
        Row: {
          actor_id: string | null
          created_at: string
          field: string
          from_status: string | null
          id: string
          note: string | null
          order_id: string
          tenant_id: string
          to_status: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          field: string
          from_status?: string | null
          id?: string
          note?: string | null
          order_id: string
          tenant_id: string
          to_status: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          field?: string
          from_status?: string | null
          id?: string
          note?: string | null
          order_id?: string
          tenant_id?: string
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_status_history_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_status_history_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_status_history_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_status_history_tenant_id_order_id_fkey"
            columns: ["tenant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      order_transitions: {
        Row: {
          from_status: string
          to_status: string
        }
        Insert: {
          from_status: string
          to_status: string
        }
        Update: {
          from_status?: string
          to_status?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          cancelled_reason: string | null
          cart_id: string | null
          channel_ref: string | null
          cod_fee_centavos: number
          contact_email: string | null
          contact_name: string
          contact_phone: string
          created_at: string
          customer_id: string | null
          discount_total_centavos: number
          fulfillment_status: string
          grand_total_centavos: number
          id: string
          location_id: string | null
          notes: string | null
          order_number: string
          payment_method: string
          payment_status: string
          placed_at: string
          shipping_address: Json
          shipping_total_centavos: number
          source: string
          subtotal_centavos: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          cancelled_reason?: string | null
          cart_id?: string | null
          channel_ref?: string | null
          cod_fee_centavos?: number
          contact_email?: string | null
          contact_name: string
          contact_phone: string
          created_at?: string
          customer_id?: string | null
          discount_total_centavos?: number
          fulfillment_status?: string
          grand_total_centavos: number
          id?: string
          location_id?: string | null
          notes?: string | null
          order_number: string
          payment_method: string
          payment_status?: string
          placed_at?: string
          shipping_address: Json
          shipping_total_centavos?: number
          source?: string
          subtotal_centavos: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          cancelled_reason?: string | null
          cart_id?: string | null
          channel_ref?: string | null
          cod_fee_centavos?: number
          contact_email?: string | null
          contact_name?: string
          contact_phone?: string
          created_at?: string
          customer_id?: string | null
          discount_total_centavos?: number
          fulfillment_status?: string
          grand_total_centavos?: number
          id?: string
          location_id?: string | null
          notes?: string | null
          order_number?: string
          payment_method?: string
          payment_status?: string
          placed_at?: string
          shipping_address?: Json
          shipping_total_centavos?: number
          source?: string
          subtotal_centavos?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_tenant_id_cart_id_fkey"
            columns: ["tenant_id", "cart_id"]
            isOneToOne: false
            referencedRelation: "carts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "orders_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_accounts: {
        Row: {
          callback_token: string | null
          connected_at: string | null
          created_at: string
          id: string
          is_enabled: boolean
          is_live: boolean
          provider: string
          secret_key: string | null
          tenant_id: string
          updated_at: string
          webhook_slug: string
        }
        Insert: {
          callback_token?: string | null
          connected_at?: string | null
          created_at?: string
          id?: string
          is_enabled?: boolean
          is_live?: boolean
          provider: string
          secret_key?: string | null
          tenant_id: string
          updated_at?: string
          webhook_slug?: string
        }
        Update: {
          callback_token?: string | null
          connected_at?: string | null
          created_at?: string
          id?: string
          is_enabled?: boolean
          is_live?: boolean
          provider?: string
          secret_key?: string | null
          tenant_id?: string
          updated_at?: string
          webhook_slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_refunds: {
        Row: {
          actor_id: string | null
          amount_centavos: number
          created_at: string
          id: string
          payment_id: string
          provider_ref: string | null
          raw: Json | null
          reason: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          actor_id?: string | null
          amount_centavos: number
          created_at?: string
          id?: string
          payment_id: string
          provider_ref?: string | null
          raw?: Json | null
          reason: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          actor_id?: string | null
          amount_centavos?: number
          created_at?: string
          id?: string
          payment_id?: string
          provider_ref?: string | null
          raw?: Json | null
          reason?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_refunds_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_refunds_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_refunds_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_refunds_tenant_id_payment_id_fkey"
            columns: ["tenant_id", "payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_centavos: number
          checkout_url: string | null
          created_at: string
          expires_at: string | null
          failure_reason: string | null
          fee_centavos: number | null
          id: string
          method: string
          order_id: string
          paid_at: string | null
          proof_note: string | null
          proof_path: string | null
          provider: string
          provider_ref: string | null
          raw: Json | null
          refunded_centavos: number
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          amount_centavos: number
          checkout_url?: string | null
          created_at?: string
          expires_at?: string | null
          failure_reason?: string | null
          fee_centavos?: number | null
          id?: string
          method: string
          order_id: string
          paid_at?: string | null
          proof_note?: string | null
          proof_path?: string | null
          provider: string
          provider_ref?: string | null
          raw?: Json | null
          refunded_centavos?: number
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          amount_centavos?: number
          checkout_url?: string | null
          created_at?: string
          expires_at?: string | null
          failure_reason?: string | null
          fee_centavos?: number | null
          id?: string
          method?: string
          order_id?: string
          paid_at?: string | null
          proof_note?: string | null
          proof_path?: string | null
          provider?: string
          provider_ref?: string | null
          raw?: Json | null
          refunded_centavos?: number
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenant_id_order_id_fkey"
            columns: ["tenant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      platform_secrets: {
        Row: {
          created_at: string
          key: string
          value: Json
        }
        Insert: {
          created_at?: string
          key: string
          value: Json
        }
        Update: {
          created_at?: string
          key?: string
          value?: Json
        }
        Relationships: []
      }
      post_comments: {
        Row: {
          author_name: string | null
          body: string
          comment_id: string
          created_at: string
          id: string
          parent_id: string | null
          post_id: string
          private_reply_error: string | null
          psid: string
          replied_privately: boolean
          replied_publicly: boolean
          social_account_id: string
          tenant_id: string
        }
        Insert: {
          author_name?: string | null
          body: string
          comment_id: string
          created_at?: string
          id?: string
          parent_id?: string | null
          post_id: string
          private_reply_error?: string | null
          psid: string
          replied_privately?: boolean
          replied_publicly?: boolean
          social_account_id: string
          tenant_id: string
        }
        Update: {
          author_name?: string | null
          body?: string
          comment_id?: string
          created_at?: string
          id?: string
          parent_id?: string | null
          post_id?: string
          private_reply_error?: string | null
          psid?: string
          replied_privately?: boolean
          replied_publicly?: boolean
          social_account_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_comments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_comments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_comments_tenant_id_social_account_id_fkey"
            columns: ["tenant_id", "social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "post_comments_tenant_id_social_account_id_fkey"
            columns: ["tenant_id", "social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts_safe"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      product_images: {
        Row: {
          alt: string | null
          created_at: string
          id: string
          product_id: string
          renditions: number[]
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
          renditions?: number[]
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
          renditions?: number[]
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
          {
            foreignKeyName: "product_option_values_tenant_id_option_id_fkey"
            columns: ["tenant_id", "option_id"]
            isOneToOne: false
            referencedRelation: "storefront_product_options"
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
      shipment_events: {
        Row: {
          created_at: string
          description: string | null
          id: string
          location: string | null
          occurred_at: string
          raw: Json | null
          raw_code: string
          shipment_id: string
          source: string
          status: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          location?: string | null
          occurred_at: string
          raw?: Json | null
          raw_code: string
          shipment_id: string
          source?: string
          status: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          location?: string | null
          occurred_at?: string
          raw?: Json | null
          raw_code?: string
          shipment_id?: string
          source?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipment_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_events_tenant_id_shipment_id_fkey"
            columns: ["tenant_id", "shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      shipment_status_map: {
        Row: {
          notify_event: string | null
          order_status: string | null
          shipment_status: string
        }
        Insert: {
          notify_event?: string | null
          order_status?: string | null
          shipment_status: string
        }
        Update: {
          notify_event?: string | null
          order_status?: string | null
          shipment_status?: string
        }
        Relationships: []
      }
      shipments: {
        Row: {
          booked_at: string
          cod_centavos: number
          cost_centavos: number | null
          courier: string
          created_at: string
          delivered_at: string | null
          id: string
          label_url: string | null
          order_id: string
          raw: Json | null
          service: string
          status: string
          tenant_id: string
          updated_at: string
          waybill: string
          weight_grams: number | null
        }
        Insert: {
          booked_at?: string
          cod_centavos?: number
          cost_centavos?: number | null
          courier: string
          created_at?: string
          delivered_at?: string | null
          id?: string
          label_url?: string | null
          order_id: string
          raw?: Json | null
          service: string
          status?: string
          tenant_id: string
          updated_at?: string
          waybill: string
          weight_grams?: number | null
        }
        Update: {
          booked_at?: string
          cod_centavos?: number
          cost_centavos?: number | null
          courier?: string
          created_at?: string
          delivered_at?: string | null
          id?: string
          label_url?: string | null
          order_id?: string
          raw?: Json | null
          service?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          waybill?: string
          weight_grams?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "shipments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_tenant_id_order_id_fkey"
            columns: ["tenant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      shipping_rates: {
        Row: {
          created_at: string
          flat_centavos: number | null
          free_over_centavos: number | null
          id: string
          is_active: boolean
          name: string
          rate_type: string
          sort_order: number
          tenant_id: string
          updated_at: string
          zone_id: string
        }
        Insert: {
          created_at?: string
          flat_centavos?: number | null
          free_over_centavos?: number | null
          id?: string
          is_active?: boolean
          name: string
          rate_type: string
          sort_order?: number
          tenant_id: string
          updated_at?: string
          zone_id: string
        }
        Update: {
          created_at?: string
          flat_centavos?: number | null
          free_over_centavos?: number | null
          id?: string
          is_active?: boolean
          name?: string
          rate_type?: string
          sort_order?: number
          tenant_id?: string
          updated_at?: string
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipping_rates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipping_rates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipping_rates_tenant_id_zone_id_fkey"
            columns: ["tenant_id", "zone_id"]
            isOneToOne: false
            referencedRelation: "shipping_zones"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      shipping_weight_tiers: {
        Row: {
          created_at: string
          id: string
          price_centavos: number
          rate_id: string
          tenant_id: string
          up_to_grams: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          price_centavos: number
          rate_id: string
          tenant_id: string
          up_to_grams?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          price_centavos?: number
          rate_id?: string
          tenant_id?: string
          up_to_grams?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "shipping_weight_tiers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipping_weight_tiers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipping_weight_tiers_tenant_id_rate_id_fkey"
            columns: ["tenant_id", "rate_id"]
            isOneToOne: false
            referencedRelation: "shipping_rates"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      shipping_zone_areas: {
        Row: {
          city_code: string | null
          created_at: string
          id: string
          level: string
          province_code: string | null
          region_code: string | null
          tenant_id: string
          zone_id: string
        }
        Insert: {
          city_code?: string | null
          created_at?: string
          id?: string
          level: string
          province_code?: string | null
          region_code?: string | null
          tenant_id: string
          zone_id: string
        }
        Update: {
          city_code?: string | null
          created_at?: string
          id?: string
          level?: string
          province_code?: string | null
          region_code?: string | null
          tenant_id?: string
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipping_zone_areas_city_code_fkey"
            columns: ["city_code"]
            isOneToOne: false
            referencedRelation: "psgc_address_units"
            referencedColumns: ["city_code"]
          },
          {
            foreignKeyName: "shipping_zone_areas_city_code_fkey"
            columns: ["city_code"]
            isOneToOne: false
            referencedRelation: "psgc_cities"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "shipping_zone_areas_province_code_fkey"
            columns: ["province_code"]
            isOneToOne: false
            referencedRelation: "psgc_address_units"
            referencedColumns: ["province_code"]
          },
          {
            foreignKeyName: "shipping_zone_areas_province_code_fkey"
            columns: ["province_code"]
            isOneToOne: false
            referencedRelation: "psgc_provinces"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "shipping_zone_areas_region_code_fkey"
            columns: ["region_code"]
            isOneToOne: false
            referencedRelation: "psgc_address_units"
            referencedColumns: ["region_code"]
          },
          {
            foreignKeyName: "shipping_zone_areas_region_code_fkey"
            columns: ["region_code"]
            isOneToOne: false
            referencedRelation: "psgc_regions"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "shipping_zone_areas_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipping_zone_areas_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipping_zone_areas_tenant_id_zone_id_fkey"
            columns: ["tenant_id", "zone_id"]
            isOneToOne: false
            referencedRelation: "shipping_zones"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      shipping_zones: {
        Row: {
          created_at: string
          id: string
          is_default: boolean
          name: string
          sort_order: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_default?: boolean
          name: string
          sort_order?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          sort_order?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipping_zones_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipping_zones_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_credit_entries: {
        Row: {
          balance_after: number
          created_at: string
          delta: number
          id: string
          note: string | null
          reason: string
          seq: number
          sms_log_id: string | null
          tenant_id: string
        }
        Insert: {
          balance_after: number
          created_at?: string
          delta: number
          id?: string
          note?: string | null
          reason: string
          seq?: never
          sms_log_id?: string | null
          tenant_id: string
        }
        Update: {
          balance_after?: number
          created_at?: string
          delta?: number
          id?: string
          note?: string | null
          reason?: string
          seq?: never
          sms_log_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_credit_entries_sms_log_id_fkey"
            columns: ["sms_log_id"]
            isOneToOne: false
            referencedRelation: "sms_logs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_credit_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_credit_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_logs: {
        Row: {
          body: string
          cost_centavos: number
          created_at: string
          id: string
          order_id: string | null
          provider: string
          provider_ref: string | null
          purpose: string
          segments: number
          status: string
          tenant_id: string
          to: string
        }
        Insert: {
          body: string
          cost_centavos?: number
          created_at?: string
          id?: string
          order_id?: string | null
          provider: string
          provider_ref?: string | null
          purpose: string
          segments?: number
          status: string
          tenant_id: string
          to: string
        }
        Update: {
          body?: string
          cost_centavos?: number
          created_at?: string
          id?: string
          order_id?: string | null
          provider?: string
          provider_ref?: string | null
          purpose?: string
          segments?: number
          status?: string
          tenant_id?: string
          to?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_logs_tenant_id_order_id_fkey"
            columns: ["tenant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      sms_templates: {
        Row: {
          body: string
          created_at: string
          event: string
          id: string
          is_enabled: boolean
          locale: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          event: string
          id?: string
          is_enabled?: boolean
          locale?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          event?: string
          id?: string
          is_enabled?: boolean
          locale?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      social_accounts: {
        Row: {
          connected_at: string
          connected_by: string | null
          id: string
          ig_user_id: string | null
          is_active: boolean
          page_id: string
          page_name: string | null
          platform: string
          scopes: string[]
          tenant_id: string
          token_encrypted: string | null
          token_expires_at: string | null
          updated_at: string
          webhook_subscribed: boolean
        }
        Insert: {
          connected_at?: string
          connected_by?: string | null
          id?: string
          ig_user_id?: string | null
          is_active?: boolean
          page_id: string
          page_name?: string | null
          platform: string
          scopes?: string[]
          tenant_id: string
          token_encrypted?: string | null
          token_expires_at?: string | null
          updated_at?: string
          webhook_subscribed?: boolean
        }
        Update: {
          connected_at?: string
          connected_by?: string | null
          id?: string
          ig_user_id?: string | null
          is_active?: boolean
          page_id?: string
          page_name?: string | null
          platform?: string
          scopes?: string[]
          tenant_id?: string
          token_encrypted?: string | null
          token_expires_at?: string | null
          updated_at?: string
          webhook_subscribed?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "social_accounts_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
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
      webhook_events: {
        Row: {
          created_at: string
          error_message: string | null
          event_type: string | null
          external_id: string
          id: string
          payload: Json
          processed_at: string | null
          provider: string
          status: string
          tenant_id: string | null
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          event_type?: string | null
          external_id: string
          id?: string
          payload: Json
          processed_at?: string | null
          provider: string
          status?: string
          tenant_id?: string | null
        }
        Update: {
          created_at?: string
          error_message?: string | null
          event_type?: string | null
          external_id?: string
          id?: string
          payload?: Json
          processed_at?: string | null
          provider?: string
          status?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "webhook_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      courier_accounts_safe: {
        Row: {
          account_ref: string | null
          connected_at: string | null
          courier: string | null
          created_at: string | null
          has_credentials: boolean | null
          id: string | null
          is_enabled: boolean | null
          is_live: boolean | null
          origin_address: Json | null
          sender_name: string | null
          sender_phone: string | null
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          account_ref?: string | null
          connected_at?: string | null
          courier?: string | null
          created_at?: string | null
          has_credentials?: never
          id?: string | null
          is_enabled?: boolean | null
          is_live?: boolean | null
          origin_address?: Json | null
          sender_name?: string | null
          sender_phone?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          account_ref?: string | null
          connected_at?: string | null
          courier?: string | null
          created_at?: string | null
          has_credentials?: never
          id?: string | null
          is_enabled?: boolean | null
          is_live?: boolean | null
          origin_address?: Json | null
          sender_name?: string | null
          sender_phone?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "courier_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "courier_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
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
      payment_accounts_safe: {
        Row: {
          connected_at: string | null
          created_at: string | null
          has_callback_token: boolean | null
          has_secret_key: boolean | null
          id: string | null
          is_enabled: boolean | null
          is_live: boolean | null
          provider: string | null
          secret_key_last4: string | null
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          connected_at?: string | null
          created_at?: string | null
          has_callback_token?: never
          has_secret_key?: never
          id?: string | null
          is_enabled?: boolean | null
          is_live?: boolean | null
          provider?: string | null
          secret_key_last4?: never
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          connected_at?: string | null
          created_at?: string | null
          has_callback_token?: never
          has_secret_key?: never
          id?: string | null
          is_enabled?: boolean | null
          is_live?: boolean | null
          provider?: string | null
          secret_key_last4?: never
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
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
      social_accounts_safe: {
        Row: {
          connected_at: string | null
          has_token: boolean | null
          id: string | null
          ig_user_id: string | null
          is_active: boolean | null
          page_id: string | null
          page_name: string | null
          platform: string | null
          scopes: string[] | null
          tenant_id: string | null
          token_expired: boolean | null
          token_expires_at: string | null
          webhook_subscribed: boolean | null
        }
        Insert: {
          connected_at?: string | null
          has_token?: never
          id?: string | null
          ig_user_id?: string | null
          is_active?: boolean | null
          page_id?: string | null
          page_name?: string | null
          platform?: string | null
          scopes?: string[] | null
          tenant_id?: string | null
          token_expired?: never
          token_expires_at?: string | null
          webhook_subscribed?: boolean | null
        }
        Update: {
          connected_at?: string | null
          has_token?: never
          id?: string | null
          ig_user_id?: string | null
          is_active?: boolean | null
          page_id?: string | null
          page_name?: string | null
          platform?: string | null
          scopes?: string[] | null
          tenant_id?: string | null
          token_expired?: never
          token_expires_at?: string | null
          webhook_subscribed?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "social_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "storefront_tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
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
      storefront_option_values: {
        Row: {
          id: string | null
          option_id: string | null
          sort_order: number | null
          tenant_id: string | null
          value: string | null
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
          {
            foreignKeyName: "product_option_values_tenant_id_option_id_fkey"
            columns: ["tenant_id", "option_id"]
            isOneToOne: false
            referencedRelation: "storefront_product_options"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      storefront_product_images: {
        Row: {
          alt: string | null
          id: string | null
          product_id: string | null
          renditions: number[] | null
          sort_order: number | null
          storage_path: string | null
          variant_id: string | null
        }
        Relationships: []
      }
      storefront_product_options: {
        Row: {
          id: string | null
          name: string | null
          product_id: string | null
          sort_order: number | null
          tenant_id: string | null
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
      add_order_note: {
        Args: { p_body: string; p_order_id: string }
        Returns: Json
      }
      apply_reservation: {
        Args: { p_items: Json; p_location_id: string; p_tenant_id: string }
        Returns: undefined
      }
      assert_variant_options_valid: {
        Args: { p_variant_id: string }
        Returns: undefined
      }
      attach_payment_charge: {
        Args: {
          p_checkout_url: string
          p_expires_at?: string
          p_payment_id: string
          p_provider_ref: string
          p_raw?: Json
          p_status?: string
        }
        Returns: undefined
      }
      auto_reply_for: {
        Args: {
          p_channel?: string
          p_root_url?: string
          p_tenant_id: string
          p_text: string
        }
        Returns: Json
      }
      auto_reply_for_raw: {
        Args: {
          p_channel?: string
          p_root_url?: string
          p_tenant_id: string
          p_text: string
        }
        Returns: Json
      }
      available_stock: {
        Args: { p_on_hand: number; p_reserved: number }
        Returns: number
      }
      buyer_risk_contribute: {
        Args: {
          p_delivered: number
          p_digits: string
          p_orders: number
          p_rts: number
          p_tenant_id: string
        }
        Returns: undefined
      }
      buyer_risk_hash: { Args: { p_digits: string }; Returns: string }
      buyer_risk_lookup: {
        Args: { p_phone: string; p_tenant_id: string }
        Returns: Json
      }
      buyer_risk_refresh: {
        Args: { p_phone: string; p_tenant_id: string }
        Returns: Json
      }
      buyer_risk_set_flag: {
        Args: {
          p_block_cod?: boolean
          p_note?: string
          p_phone: string
          p_tenant_id: string
          p_trusted?: boolean
        }
        Returns: Json
      }
      cart_add_item: {
        Args: { p_qty?: number; p_token: string; p_variant_id: string }
        Returns: Json
      }
      cart_create: {
        Args: { p_domain?: string; p_slug?: string }
        Returns: string
      }
      cart_id_for_token: { Args: { p_token: string }; Returns: string }
      cart_pricing: {
        Args: {
          p_cart_id: string
          p_city_code?: string
          p_payment_method?: string
          p_province_code?: string
          p_region_code?: string
        }
        Returns: Json
      }
      cart_quote_for_address: {
        Args: {
          p_city_code: string
          p_payment_method?: string
          p_province_code: string
          p_region_code: string
          p_token: string
        }
        Returns: Json
      }
      cart_set_qty: {
        Args: { p_qty: number; p_token: string; p_variant_id: string }
        Returns: Json
      }
      cart_view: {
        Args: { p_payment_method?: string; p_token: string }
        Returns: Json
      }
      catalog_slugify: { Args: { p_text: string }; Returns: string }
      checkout_online_available: {
        Args: { p_tenant_id: string }
        Returns: boolean
      }
      checkout_place_order: {
        Args: {
          p_address: Json
          p_contact_email?: string
          p_contact_name: string
          p_contact_phone: string
          p_notes?: string
          p_payment_method?: string
          p_token: string
        }
        Returns: Json
      }
      cod_discard_remittance: {
        Args: { p_remittance_id: string }
        Returns: Json
      }
      cod_import_statement: {
        Args: {
          p_courier: string
          p_declared_total?: number
          p_filename?: string
          p_lines: Json
          p_reference?: string
          p_tenant_id: string
        }
        Returns: Json
      }
      cod_post_remittance: { Args: { p_remittance_id: string }; Returns: Json }
      cod_reconciliation: {
        Args: { p_days?: number; p_tenant_id: string }
        Returns: Json
      }
      cod_remittance_lines: {
        Args: {
          p_limit?: number
          p_only_problems?: boolean
          p_remittance_id: string
        }
        Returns: Json
      }
      cod_remittance_summary: {
        Args: { p_remittance_id: string }
        Returns: Json
      }
      courier_booking_batch: {
        Args: { p_courier: string; p_order_ids: string[]; p_tenant_id: string }
        Returns: Json
      }
      courier_credentials: {
        Args: { p_account_id: string; p_key: string }
        Returns: Json
      }
      create_manual_order: {
        Args: {
          p_address: Json
          p_contact_name: string
          p_contact_phone: string
          p_items: Json
          p_notes?: string
          p_payment_method?: string
          p_tenant_id: string
        }
        Returns: Json
      }
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
      default_auto_replies: {
        Args: never
        Returns: {
          body: string
          channel: string
          keyword: string
          match_type: string
          priority: number
        }[]
      }
      default_sms_templates: {
        Args: never
        Returns: {
          body: string
          event: string
          locale: string
        }[]
      }
      has_tenant_role: {
        Args: {
          p_min_role: Database["public"]["Enums"]["tenant_role"]
          p_tenant_id: string
        }
        Returns: boolean
      }
      image_widths_are_sane: { Args: { p_widths: number[] }; Returns: boolean }
      inbox_mark_read: { Args: { p_thread_id: string }; Returns: undefined }
      inbox_thread: {
        Args: { p_limit?: number; p_thread_id: string }
        Returns: Json
      }
      inbox_threads: {
        Args: { p_limit?: number; p_status?: string; p_tenant_id: string }
        Returns: Json
      }
      is_reserved_tenant_slug: { Args: { slug: string }; Returns: boolean }
      is_tenant_member: { Args: { p_tenant_id: string }; Returns: boolean }
      is_valid_tenant_slug: { Args: { slug: string }; Returns: boolean }
      live_claim_cancel: { Args: { p_claim_id: string }; Returns: Json }
      live_console: { Args: { p_session_id: string }; Returns: Json }
      live_expire_claims: {
        Args: { p_all?: boolean; p_session_id?: string }
        Returns: Json
      }
      live_ingest_comment: {
        Args: {
          p_author_name?: string
          p_body: string
          p_claims?: Json
          p_external_id: string
          p_psid: string
          p_reason?: string
          p_session_id: string
          p_unknown_codes?: Json
        }
        Returns: Json
      }
      live_ingest_manual: {
        Args: {
          p_author_name?: string
          p_body: string
          p_claims?: Json
          p_external_id: string
          p_psid: string
          p_reason?: string
          p_session_id: string
          p_unknown_codes?: Json
        }
        Returns: Json
      }
      live_item_add: {
        Args: {
          p_allocated?: number
          p_claim_code: string
          p_session_id: string
          p_variant_id: string
        }
        Returns: Json
      }
      live_session_create: {
        Args: {
          p_channel?: string
          p_external_ref?: string
          p_tenant_id: string
          p_title: string
          p_window_minutes?: number
        }
        Returns: Json
      }
      live_session_for_ref: {
        Args: { p_channel: string; p_ref: string }
        Returns: Json
      }
      live_session_update: {
        Args: {
          p_current_code?: string
          p_session_id: string
          p_status?: string
        }
        Returns: Json
      }
      live_sessions_list: {
        Args: { p_limit?: number; p_tenant_id: string }
        Returns: Json
      }
      log_integration_attempt: {
        Args: {
          p_attempt?: number
          p_duration_ms?: number
          p_error_code?: string
          p_error_message?: string
          p_http_status?: number
          p_idempotency_key: string
          p_operation: string
          p_provider: string
          p_status: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      message_send_allowed: {
        Args: { p_automated?: boolean; p_tag?: string; p_thread_id: string }
        Returns: Json
      }
      message_send_allowed_raw: {
        Args: { p_automated?: boolean; p_tag?: string; p_thread_id: string }
        Returns: Json
      }
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
      next_order_number: { Args: { p_tenant_id: string }; Returns: string }
      open_refund: {
        Args: { p_amount: number; p_payment_id: string; p_reason: string }
        Returns: Json
      }
      order_detail: { Args: { p_order_id: string }; Returns: Json }
      order_receipt: { Args: { p_order_id: string }; Returns: Json }
      order_receipt_for_token: { Args: { p_token: string }; Returns: Json }
      orders_bulk_transition: {
        Args: {
          p_note?: string
          p_order_ids: string[]
          p_tenant_id: string
          p_to_status: string
        }
        Returns: Json
      }
      orders_list: {
        Args: {
          p_before_id?: string
          p_before_placed_at?: string
          p_limit?: number
          p_search?: string
          p_tenant_id: string
          p_view?: string
        }
        Returns: Json
      }
      orders_packing_batch: {
        Args: { p_order_ids: string[]; p_tenant_id: string }
        Returns: Json
      }
      orders_view_counts: { Args: { p_tenant_id: string }; Returns: Json }
      payment_account_for_webhook: {
        Args: { p_slug: string }
        Returns: {
          callback_token: string
          is_enabled: boolean
          provider: string
          tenant_id: string
        }[]
      }
      payment_credentials_for_payment: {
        Args: { p_payment_id: string }
        Returns: {
          callback_token: string
          is_live: boolean
          secret_key: string
          tenant_id: string
        }[]
      }
      payment_open_for_token: {
        Args: { p_method: string; p_order_id: string; p_token: string }
        Returns: Json
      }
      payment_status_for_token: {
        Args: { p_order_id: string; p_token: string }
        Returns: Json
      }
      ph_national_digits: { Args: { p_input: string }; Returns: string }
      public_tracking: {
        Args: { p_domain: string; p_order_number: string; p_slug: string }
        Returns: Json
      }
      quote_shipping: {
        Args: {
          p_city_code: string
          p_province_code: string
          p_region_code: string
          p_subtotal: number
          p_tenant_id: string
          p_weight_grams?: number
        }
        Returns: Json
      }
      record_booking_failure: {
        Args: {
          p_code?: string
          p_courier: string
          p_kind: string
          p_message: string
          p_order_id: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      record_cod_remittance: {
        Args: { p_amount?: number; p_note?: string; p_order_id: string }
        Returns: Json
      }
      record_comment_dm: {
        Args: { p_body: string; p_comment_row: string; p_external_id?: string }
        Returns: string
      }
      record_comment_reply: {
        Args: {
          p_comment_row: string
          p_error?: string
          p_privately: boolean
          p_publicly: boolean
        }
        Returns: undefined
      }
      record_inbound_message: {
        Args: {
          p_account_id: string
          p_attachments?: Json
          p_body: string
          p_external_id: string
          p_name?: string
          p_psid: string
          p_root_url?: string
          p_sent_at?: string
        }
        Returns: Json
      }
      record_manual_payment: {
        Args: {
          p_amount: number
          p_method: string
          p_note?: string
          p_order_id: string
          p_paid_at?: string
          p_proof_path?: string
        }
        Returns: Json
      }
      record_order_sms: {
        Args: {
          p_body: string
          p_cost_centavos?: number
          p_idempotency_key?: string
          p_provider: string
          p_provider_ref: string
          p_segments?: number
          p_status: string
          p_token: string
        }
        Returns: boolean
      }
      record_outbound_message: {
        Args: {
          p_body: string
          p_error?: string
          p_external_id?: string
          p_source?: string
          p_status?: string
          p_tag?: string
          p_thread_id: string
        }
        Returns: Json
      }
      record_payment_event: {
        Args: {
          p_amount: number
          p_event_type: string
          p_external_id: string
          p_fee?: number
          p_paid_at?: string
          p_payload: Json
          p_provider: string
          p_provider_ref: string
          p_status: string
        }
        Returns: Json
      }
      record_post_comment: {
        Args: {
          p_account_id: string
          p_author_name?: string
          p_body: string
          p_comment_id: string
          p_parent_id?: string
          p_post_id: string
          p_psid: string
          p_root_url?: string
        }
        Returns: Json
      }
      record_rts: {
        Args: {
          p_location_id?: string
          p_note?: string
          p_order_id: string
          p_reason: string
          p_restock?: boolean
          p_return_cost?: number
        }
        Returns: Json
      }
      record_shipment: {
        Args: {
          p_cod?: number
          p_cost?: number
          p_courier: string
          p_label_url?: string
          p_order_id: string
          p_raw?: Json
          p_service: string
          p_tenant_id: string
          p_waybill: string
          p_weight?: number
        }
        Returns: Json
      }
      record_shipment_event: {
        Args: {
          p_courier: string
          p_description?: string
          p_location?: string
          p_occurred_at: string
          p_raw?: Json
          p_raw_code: string
          p_source?: string
          p_status: string
          p_waybill: string
        }
        Returns: Json
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
      record_tracking_sms: {
        Args: {
          p_body: string
          p_cost?: number
          p_event: string
          p_order_id: string
          p_provider: string
          p_provider_ref: string
          p_segments?: number
          p_status: string
          p_tenant_id: string
          p_to: string
        }
        Returns: Json
      }
      release_reservation: {
        Args: { p_items: Json; p_location_id: string; p_tenant_id: string }
        Returns: undefined
      }
      release_reservation_raw: {
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
      reserve_stock_raw: {
        Args: { p_items: Json; p_location_id: string; p_tenant_id: string }
        Returns: undefined
      }
      resolve_shipping_zone: {
        Args: {
          p_city_code: string
          p_province_code: string
          p_region_code: string
          p_tenant_id: string
        }
        Returns: string
      }
      rts_report: {
        Args: { p_days?: number; p_tenant_id: string }
        Returns: Json
      }
      seed_categories_from_presets: {
        Args: { p_names: string[]; p_tenant_id: string }
        Returns: number
      }
      seed_shipping_presets: {
        Args: {
          p_free_over?: number
          p_metro_centavos?: number
          p_rest_centavos?: number
          p_tenant_id: string
        }
        Returns: number
      }
      set_courier_credentials: {
        Args: {
          p_courier: string
          p_credentials: Json
          p_key: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      set_social_page_token: {
        Args: {
          p_account_id: string
          p_expires_at?: string
          p_key: string
          p_subscribed?: boolean
          p_token: string
        }
        Returns: undefined
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
      settle_refund: {
        Args: {
          p_provider_ref?: string
          p_raw?: Json
          p_refund_id: string
          p_status: string
        }
        Returns: Json
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
      shipment_labels: {
        Args: { p_order_ids: string[]; p_tenant_id: string }
        Returns: Json
      }
      shipments_to_poll: {
        Args: { p_limit?: number; p_stale_after?: string }
        Returns: Json
      }
      sms_credit_balance: { Args: { p_tenant_id: string }; Returns: number }
      sms_credit_balance_raw: { Args: { p_tenant_id: string }; Returns: number }
      sms_credit_move: {
        Args: {
          p_delta: number
          p_note?: string
          p_reason: string
          p_sms_log_id?: string
          p_tenant_id: string
        }
        Returns: number
      }
      sms_render_for_order: {
        Args: { p_event: string; p_order_id: string; p_root_url: string }
        Returns: Json
      }
      social_account_connect: {
        Args: {
          p_ig_user_id?: string
          p_page_id: string
          p_page_name?: string
          p_platform: string
          p_scopes?: string[]
          p_tenant_id: string
        }
        Returns: string
      }
      social_account_disconnect: {
        Args: { p_account_id: string }
        Returns: undefined
      }
      social_account_for_page: {
        Args: { p_page_id: string; p_platform: string }
        Returns: Json
      }
      social_account_for_thread: {
        Args: { p_thread_id: string }
        Returns: Json
      }
      social_page_token: {
        Args: { p_key: string; p_page_id: string; p_platform: string }
        Returns: string
      }
      storage_path_tenant_id: { Args: { p_name: string }; Returns: string }
      storefront_home: {
        Args: {
          p_category?: string
          p_domain?: string
          p_limit?: number
          p_offset?: number
          p_search?: string
          p_slug?: string
        }
        Returns: Json
      }
      storefront_payment_methods: {
        Args: { p_domain?: string; p_slug?: string }
        Returns: Json
      }
      storefront_product_cards: {
        Args: {
          p_category?: string
          p_exclude?: string
          p_limit?: number
          p_offset?: number
          p_search?: string
          p_tenant_id: string
        }
        Returns: Json
      }
      storefront_product_page: {
        Args: { p_domain?: string; p_product_slug: string; p_slug?: string }
        Returns: Json
      }
      storefront_sitemap: {
        Args: { p_domain?: string; p_slug?: string }
        Returns: Json
      }
      storefront_store_json: { Args: { p_tenant_id: string }; Returns: Json }
      storefront_tenant_id: {
        Args: { p_domain?: string; p_slug?: string }
        Returns: string
      }
      sync_order_payment_status: {
        Args: { p_note?: string; p_order_id: string }
        Returns: string
      }
      tenant_role_of: {
        Args: { p_tenant_id: string }
        Returns: Database["public"]["Enums"]["tenant_role"]
      }
      tenant_role_rank: {
        Args: { role: Database["public"]["Enums"]["tenant_role"] }
        Returns: number
      }
      tenant_store_url: {
        Args: { p_root_url?: string; p_tenant_id: string }
        Returns: string
      }
      update_rts_cost: {
        Args: { p_return_cost: number; p_rts_id: string }
        Returns: Json
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

