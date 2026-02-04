ALTER TABLE "agents" ADD COLUMN "verification_code" varchar(20);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "claimed_by_twitter" varchar(100);--> statement-breakpoint
CREATE INDEX "agents_verification_code_idx" ON "agents" USING btree ("verification_code");