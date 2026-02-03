CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"owner_handle" varchar(100) NOT NULL,
	"description" text,
	"avatar_emoji" varchar(10) DEFAULT '🤖',
	"registered_at" timestamp DEFAULT now() NOT NULL,
	"last_seen" timestamp DEFAULT now() NOT NULL,
	"reputation" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"auth_token" text NOT NULL,
	"home_location_id" text,
	CONSTRAINT "agents_auth_token_unique" UNIQUE("auth_token")
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"author_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"title" varchar(200),
	"location_id" text,
	"is_public" boolean DEFAULT true NOT NULL,
	"participant_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_message_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text NOT NULL,
	"type" varchar(20) DEFAULT 'public' NOT NULL,
	"capacity" integer DEFAULT 50 NOT NULL,
	"parent_id" text,
	"position_x" integer DEFAULT 0 NOT NULL,
	"position_y" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "presence" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"location_id" text NOT NULL,
	"activity" varchar(100),
	"arrived_at" timestamp DEFAULT now() NOT NULL,
	"last_heartbeat" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"agent_a_id" text NOT NULL,
	"agent_b_id" text NOT NULL,
	"sentiment" real DEFAULT 0 NOT NULL,
	"interaction_count" integer DEFAULT 0 NOT NULL,
	"last_interaction" timestamp DEFAULT now() NOT NULL,
	"notes" text,
	CONSTRAINT "relationships_agent_a_id_agent_b_id_pk" PRIMARY KEY("agent_a_id","agent_b_id")
);
--> statement-breakpoint
CREATE TABLE "scheduled_events" (
	"id" text PRIMARY KEY NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"organizer_id" text NOT NULL,
	"location_id" text NOT NULL,
	"starts_at" timestamp NOT NULL,
	"invited_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attending_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" varchar(50) NOT NULL,
	"location_id" text,
	"actor_id" text,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"location_id" text NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"affordances" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_author_id_agents_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_agent_a_id_agents_id_fk" FOREIGN KEY ("agent_a_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_agent_b_id_agents_id_fk" FOREIGN KEY ("agent_b_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_events" ADD CONSTRAINT "scheduled_events_organizer_id_agents_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_events" ADD CONSTRAINT "scheduled_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_events" ADD CONSTRAINT "world_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_events" ADD CONSTRAINT "world_events_actor_id_agents_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_objects" ADD CONSTRAINT "world_objects_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_auth_token_idx" ON "agents" USING btree ("auth_token");--> statement-breakpoint
CREATE INDEX "agents_status_idx" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agents_last_seen_idx" ON "agents" USING btree ("last_seen");--> statement-breakpoint
CREATE INDEX "messages_conversation_time_idx" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "locations_type_idx" ON "locations" USING btree ("type");--> statement-breakpoint
CREATE INDEX "locations_position_idx" ON "locations" USING btree ("position_x","position_y");--> statement-breakpoint
CREATE INDEX "presence_location_idx" ON "presence" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "presence_heartbeat_idx" ON "presence" USING btree ("agent_id","last_heartbeat");--> statement-breakpoint
CREATE INDEX "relationships_agent_a_idx" ON "relationships" USING btree ("agent_a_id");--> statement-breakpoint
CREATE INDEX "events_location_time_idx" ON "world_events" USING btree ("location_id","timestamp");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "world_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "world_objects_location_idx" ON "world_objects" USING btree ("location_id");