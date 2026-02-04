CREATE TABLE "discovery_badges" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"item_id" text NOT NULL,
	"discovered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"item_id" text NOT NULL,
	"order_type" varchar(10) NOT NULL,
	"price" integer NOT NULL,
	"quantity" integer NOT NULL,
	"filled_quantity" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"price" integer NOT NULL,
	"quantity" integer NOT NULL,
	"buy_order_id" text,
	"sell_order_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "discovered_by" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "recipe" jsonb;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "craft_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_badges" ADD CONSTRAINT "discovery_badges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_badges" ADD CONSTRAINT "discovery_badges_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_trades" ADD CONSTRAINT "market_trades_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_trades" ADD CONSTRAINT "market_trades_buyer_id_agents_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_trades" ADD CONSTRAINT "market_trades_seller_id_agents_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_trades" ADD CONSTRAINT "market_trades_buy_order_id_market_orders_id_fk" FOREIGN KEY ("buy_order_id") REFERENCES "public"."market_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_trades" ADD CONSTRAINT "market_trades_sell_order_id_market_orders_id_fk" FOREIGN KEY ("sell_order_id") REFERENCES "public"."market_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovery_badges_agent_idx" ON "discovery_badges" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "discovery_badges_item_idx" ON "discovery_badges" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "market_orders_agent_idx" ON "market_orders" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "market_orders_item_idx" ON "market_orders" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "market_orders_status_idx" ON "market_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "market_orders_price_idx" ON "market_orders" USING btree ("item_id","order_type","price");--> statement-breakpoint
CREATE INDEX "market_trades_item_idx" ON "market_trades" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "market_trades_created_at_idx" ON "market_trades" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_discovered_by_agents_id_fk" FOREIGN KEY ("discovered_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_discovered_by_idx" ON "items" USING btree ("discovered_by");