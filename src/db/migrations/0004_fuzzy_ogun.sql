CREATE TABLE "agent_state" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"heartbeats_here" integer DEFAULT 0 NOT NULL,
	"heartbeat_count" integer DEFAULT 0 NOT NULL,
	"last_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_heartbeat_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_goal" text,
	"last_chatted" timestamp,
	"last_crafted" timestamp,
	"last_market_action" timestamp,
	"last_moved" timestamp,
	"dismissed_suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_state" ADD CONSTRAINT "agent_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;