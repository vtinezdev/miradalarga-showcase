CREATE TABLE "external_availability_announcements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "external_availability_announcements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title_id" bigint NOT NULL,
	"platform_id" text NOT NULL,
	"country" text NOT NULL,
	"offer_type" "offer_type" NOT NULL,
	"addon" text,
	"announced_for" timestamp with time zone NOT NULL,
	"first_announced_for" timestamp with time zone NOT NULL,
	"link" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_seen_run_id" bigint,
	CONSTRAINT "external_availability_announcements_key" UNIQUE NULLS NOT DISTINCT("title_id","platform_id","country","offer_type","addon"),
	CONSTRAINT "external_availability_announcements_vistas_ordenadas" CHECK ("external_availability_announcements"."last_seen_at" >= "external_availability_announcements"."first_seen_at")
);
--> statement-breakpoint
ALTER TABLE "external_availability_announcements" ADD CONSTRAINT "external_availability_announcements_title_id_external_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."external_titles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_availability_announcements" ADD CONSTRAINT "external_availability_announcements_platform_id_external_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."external_platforms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_availability_announcements" ADD CONSTRAINT "external_availability_announcements_last_seen_run_id_ops_sync_runs_id_fk" FOREIGN KEY ("last_seen_run_id") REFERENCES "public"."ops_sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_availability_announcements_country_announced_for_idx" ON "external_availability_announcements" USING btree ("country","announced_for");