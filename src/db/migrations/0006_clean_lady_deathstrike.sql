CREATE TABLE "bounty_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"bounty_id" text NOT NULL,
	"proposer_id" text NOT NULL,
	"item_id" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"message" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "bounties" ALTER COLUMN "item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bounties" ADD COLUMN "bounty_type" varchar(20) DEFAULT 'item' NOT NULL;--> statement-breakpoint
ALTER TABLE "bounties" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "bounty_proposals" ADD CONSTRAINT "bounty_proposals_bounty_id_bounties_id_fk" FOREIGN KEY ("bounty_id") REFERENCES "public"."bounties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_proposals" ADD CONSTRAINT "bounty_proposals_proposer_id_agents_id_fk" FOREIGN KEY ("proposer_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_proposals" ADD CONSTRAINT "bounty_proposals_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bounty_proposals_bounty_idx" ON "bounty_proposals" USING btree ("bounty_id");--> statement-breakpoint
CREATE INDEX "bounty_proposals_proposer_idx" ON "bounty_proposals" USING btree ("proposer_id");--> statement-breakpoint
CREATE INDEX "bounty_proposals_status_idx" ON "bounty_proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bounties_bounty_type_idx" ON "bounties" USING btree ("bounty_type");