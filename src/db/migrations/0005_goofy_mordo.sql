CREATE TABLE "bounties" (
	"id" text PRIMARY KEY NOT NULL,
	"creator_id" text NOT NULL,
	"item_id" text NOT NULL,
	"reward" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"fulfilled_by" text,
	"message" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"fulfilled_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_creator_id_agents_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_fulfilled_by_agents_id_fk" FOREIGN KEY ("fulfilled_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bounties_creator_idx" ON "bounties" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "bounties_item_idx" ON "bounties" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "bounties_status_idx" ON "bounties" USING btree ("status");