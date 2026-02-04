CREATE TABLE "accounts" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 1000000 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"item_id" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"acquired_at" timestamp DEFAULT now() NOT NULL,
	"acquired_price" integer
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"category" varchar(30) NOT NULL,
	"base_price" integer NOT NULL,
	"emoji" varchar(10),
	"effects" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tradeable" boolean DEFAULT true NOT NULL,
	"limited" boolean DEFAULT false NOT NULL,
	"max_supply" integer,
	"current_supply" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" text PRIMARY KEY NOT NULL,
	"from_agent_id" text NOT NULL,
	"to_agent_id" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"offer_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"offer_amount" integer DEFAULT 0 NOT NULL,
	"request_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_amount" integer DEFAULT 0 NOT NULL,
	"message" text,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"from_agent_id" text,
	"to_agent_id" text,
	"amount" integer NOT NULL,
	"type" varchar(30) NOT NULL,
	"description" text,
	"reference_id" text,
	"reference_type" varchar(30),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_agent_idx" ON "inventory" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "inventory_item_idx" ON "inventory" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "inventory_agent_item_idx" ON "inventory" USING btree ("agent_id","item_id");--> statement-breakpoint
CREATE INDEX "items_category_idx" ON "items" USING btree ("category");--> statement-breakpoint
CREATE INDEX "trades_from_agent_idx" ON "trades" USING btree ("from_agent_id");--> statement-breakpoint
CREATE INDEX "trades_to_agent_idx" ON "trades" USING btree ("to_agent_id");--> statement-breakpoint
CREATE INDEX "trades_status_idx" ON "trades" USING btree ("status");--> statement-breakpoint
CREATE INDEX "transactions_from_agent_idx" ON "transactions" USING btree ("from_agent_id");--> statement-breakpoint
CREATE INDEX "transactions_to_agent_idx" ON "transactions" USING btree ("to_agent_id");--> statement-breakpoint
CREATE INDEX "transactions_type_idx" ON "transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "transactions_created_at_idx" ON "transactions" USING btree ("created_at");