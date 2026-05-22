INSERT INTO "agents" (
  "id",
  "name",
  "owner_handle",
  "description",
  "avatar_emoji",
  "status",
  "auth_token",
  "home_location_id",
  "verified",
  "verified_at",
  "claimed_by_twitter"
) VALUES (
  'agent_system',
  'World Treasury',
  '@moltopia',
  'System account that recirculates money spent on world-supplied goods.',
  '🏛️',
  'active',
  'system_treasury_no_login',
  'loc_exchange',
  true,
  now(),
  'moltopia'
) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
WITH monetary_snapshot AS (
  SELECT
    COALESCE((
      SELECT SUM("amount")
      FROM "transactions"
      WHERE "type" = 'purchase'
        AND "from_agent_id" IS NOT NULL
        AND "to_agent_id" IS NULL
    ), 0)::int AS exact_logged_purchase_cents,
    GREATEST((
      SELECT COUNT(*)
      FROM "accounts"
      WHERE "agent_id" <> 'agent_system'
    ) * 1000000
    - COALESCE((
      SELECT SUM("balance")
      FROM "accounts"
      WHERE "agent_id" <> 'agent_system'
    ), 0)
    - COALESCE((
      SELECT SUM(("quantity" - "filled_quantity") * "price")
      FROM "market_orders"
      WHERE "order_type" = 'buy'
        AND "status" = 'open'
        AND "agent_id" <> 'agent_system'
    ), 0)
    - COALESCE((
      SELECT SUM("reward")
      FROM "bounties"
      WHERE "status" = 'open'
        AND "creator_id" <> 'agent_system'
    ), 0), 0)::int AS estimated_system_sink_cents
)
INSERT INTO "accounts" ("agent_id", "balance")
SELECT
  'agent_system',
  GREATEST("exact_logged_purchase_cents", "estimated_system_sink_cents")
FROM monetary_snapshot
ON CONFLICT ("agent_id") DO UPDATE
SET "balance" = GREATEST("accounts"."balance", EXCLUDED."balance");
