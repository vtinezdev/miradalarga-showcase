CREATE TYPE "public"."capability" AS ENUM('expiring', 'upcoming', 'official_top', 'prices', 'popularity_order');--> statement-breakpoint
CREATE TYPE "public"."capability_status" AS ENUM('supported_with_data', 'supported_no_data_in_sample', 'not_supported', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('announced', 'added', 'changed', 'removed');--> statement-breakpoint
CREATE TYPE "public"."image_type" AS ENUM('vertical_poster', 'horizontal_poster', 'vertical_backdrop', 'horizontal_backdrop');--> statement-breakpoint
CREATE TYPE "public"."list_kind" AS ENUM('popularity', 'official_top');--> statement-breakpoint
CREATE TYPE "public"."offer_type" AS ENUM('subscription', 'rent', 'buy', 'free', 'addon');--> statement-breakpoint
CREATE TYPE "public"."popularity_window" AS ENUM('1week', '1month', '1year', 'alltime');--> statement-breakpoint
CREATE TYPE "public"."quality" AS ENUM('sd', 'hd', 'uhd');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('running', 'succeeded', 'failed', 'budget_stopped');--> statement-breakpoint
CREATE TYPE "public"."title_type" AS ENUM('movie', 'series');--> statement-breakpoint
CREATE TABLE "external_genres" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_title_genres" (
	"title_id" bigint NOT NULL,
	"genre_id" text NOT NULL,
	CONSTRAINT "external_title_genres_pkey" PRIMARY KEY("title_id","genre_id")
);
--> statement-breakpoint
CREATE TABLE "external_title_images" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "external_title_images_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title_id" bigint NOT NULL,
	"type" "image_type" NOT NULL,
	"width" integer NOT NULL,
	"language" text,
	"observed_url" text NOT NULL,
	"url_expires_at" timestamp with time zone,
	"captured_at" timestamp with time zone NOT NULL,
	"is_placeholder" boolean NOT NULL,
	"path_base" text,
	CONSTRAINT "external_title_images_key" UNIQUE NULLS NOT DISTINCT("title_id","type","width","language")
);
--> statement-breakpoint
CREATE TABLE "external_titles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "external_titles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" "title_type" NOT NULL,
	"imdb_id" text NOT NULL,
	"tmdb_id" text,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"original_title" text,
	"overview" text,
	"rating" integer,
	"year" integer,
	"end_year" integer,
	"runtime_minutes" integer,
	"season_count" integer,
	"episode_count" integer,
	"cast_members" text[] NOT NULL,
	"directors" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_titles_imdb_id_key" UNIQUE("imdb_id"),
	CONSTRAINT "external_titles_source_key" UNIQUE("source","source_id"),
	CONSTRAINT "external_titles_rating_rango" CHECK ("external_titles"."rating" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "external_availability" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "external_availability_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title_id" bigint NOT NULL,
	"platform_id" text NOT NULL,
	"country" text NOT NULL,
	"offer_type" "offer_type" NOT NULL,
	"addon" text,
	"last_checked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_run_id" bigint,
	CONSTRAINT "external_availability_key" UNIQUE NULLS NOT DISTINCT("title_id","platform_id","country","offer_type","addon")
);
--> statement-breakpoint
CREATE TABLE "external_availability_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "external_availability_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"availability_id" bigint NOT NULL,
	"event_type" "event_type" NOT NULL,
	"changed_fields" text[],
	"before" jsonb,
	"after" jsonb,
	"event_digest" text NOT NULL,
	"dedupe_bucket_at" timestamp with time zone NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"sync_run_id" bigint,
	CONSTRAINT "external_availability_events_key" UNIQUE("availability_id","event_type","event_digest","dedupe_bucket_at")
);
--> statement-breakpoint
CREATE TABLE "external_availability_options" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "external_availability_options_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"availability_id" bigint NOT NULL,
	"link" text NOT NULL,
	"video_link" text,
	"quality" "quality",
	"price_amount" numeric(12, 2),
	"price_currency" text,
	"audio_languages" text[] NOT NULL,
	"subtitle_languages" text[] NOT NULL,
	"available_since" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"missing_streak" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "external_availability_options_key" UNIQUE NULLS NOT DISTINCT("availability_id","link","quality"),
	CONSTRAINT "external_availability_options_missing_streak_no_negativo" CHECK ("external_availability_options"."missing_streak" >= 0),
	CONSTRAINT "external_availability_options_precio_completo" CHECK (("external_availability_options"."price_amount" IS NULL) = ("external_availability_options"."price_currency" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "external_platform_capabilities" (
	"platform_id" text NOT NULL,
	"country" text NOT NULL,
	"capability" "capability" NOT NULL,
	"status" "capability_status" NOT NULL,
	CONSTRAINT "external_platform_capabilities_pkey" PRIMARY KEY("platform_id","country","capability")
);
--> statement-breakpoint
CREATE TABLE "external_platforms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"public_slug" text NOT NULL,
	"is_active" boolean NOT NULL,
	CONSTRAINT "external_platforms_public_slug_key" UNIQUE("public_slug"),
	CONSTRAINT "external_platforms_source_key" UNIQUE("source","source_id")
);
--> statement-breakpoint
CREATE TABLE "external_list_captures" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "external_list_captures_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"list_kind" "list_kind" NOT NULL,
	"platform_id" text NOT NULL,
	"country" text NOT NULL,
	"title_type" "title_type",
	"window" "popularity_window",
	"bucket_start_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"requested_depth" integer,
	"obtained_depth" integer NOT NULL,
	"truncated" boolean,
	"sync_run_id" bigint,
	CONSTRAINT "external_list_captures_key" UNIQUE NULLS NOT DISTINCT("list_kind","platform_id","country","title_type","window","bucket_start_at"),
	CONSTRAINT "external_list_captures_obtained_depth_no_negativo" CHECK ("external_list_captures"."obtained_depth" >= 0),
	CONSTRAINT "external_list_captures_requested_depth_positivo" CHECK ("external_list_captures"."requested_depth" IS NULL OR "external_list_captures"."requested_depth" >= 1),
	CONSTRAINT "external_list_captures_ventana_coherente" CHECK (("external_list_captures"."list_kind" = 'popularity' AND "external_list_captures"."window" IS NOT NULL) OR ("external_list_captures"."list_kind" = 'official_top' AND "external_list_captures"."window" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "external_list_positions" (
	"capture_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"title_id" bigint NOT NULL,
	CONSTRAINT "external_list_positions_pkey" PRIMARY KEY("capture_id","position"),
	CONSTRAINT "external_list_positions_title_key" UNIQUE("capture_id","title_id"),
	CONSTRAINT "external_list_positions_position_positiva" CHECK ("external_list_positions"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "derived_ranking_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"country" text NOT NULL,
	"title_type" "title_type",
	"source_signal" text NOT NULL,
	"filters" jsonb,
	"formula_version" integer NOT NULL,
	"weights" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "derived_ranking_entries" (
	"ranking_id" text NOT NULL,
	"position" integer NOT NULL,
	"title_id" bigint NOT NULL,
	"score_breakdown" jsonb NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "derived_ranking_entries_pkey" PRIMARY KEY("ranking_id","position"),
	CONSTRAINT "derived_ranking_entries_title_key" UNIQUE("ranking_id","title_id"),
	CONSTRAINT "derived_ranking_entries_position_positiva" CHECK ("derived_ranking_entries"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ops_sync_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ops_sync_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"pipeline" text NOT NULL,
	"status" "sync_run_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"requests_made" integer DEFAULT 0 NOT NULL,
	"budget_limit" integer,
	"rows_affected" jsonb,
	"multi_link_offers" integer DEFAULT 0 NOT NULL,
	"far_future_expiries" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"error_samples" jsonb,
	"commit_sha" text,
	CONSTRAINT "ops_sync_runs_error_count_no_negativo" CHECK ("ops_sync_runs"."error_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "external_title_genres" ADD CONSTRAINT "external_title_genres_title_id_external_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."external_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_title_genres" ADD CONSTRAINT "external_title_genres_genre_id_external_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."external_genres"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_title_images" ADD CONSTRAINT "external_title_images_title_id_external_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."external_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_availability" ADD CONSTRAINT "external_availability_title_id_external_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."external_titles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_availability" ADD CONSTRAINT "external_availability_platform_id_external_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."external_platforms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_availability" ADD CONSTRAINT "external_availability_sync_run_id_ops_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."ops_sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_availability_events" ADD CONSTRAINT "external_availability_events_availability_id_external_availability_id_fk" FOREIGN KEY ("availability_id") REFERENCES "public"."external_availability"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_availability_events" ADD CONSTRAINT "external_availability_events_sync_run_id_ops_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."ops_sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_availability_options" ADD CONSTRAINT "external_availability_options_availability_id_external_availability_id_fk" FOREIGN KEY ("availability_id") REFERENCES "public"."external_availability"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_platform_capabilities" ADD CONSTRAINT "external_platform_capabilities_platform_id_external_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."external_platforms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_list_captures" ADD CONSTRAINT "external_list_captures_platform_id_external_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."external_platforms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_list_captures" ADD CONSTRAINT "external_list_captures_sync_run_id_ops_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."ops_sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_list_positions" ADD CONSTRAINT "external_list_positions_capture_id_external_list_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."external_list_captures"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_list_positions" ADD CONSTRAINT "external_list_positions_title_id_external_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."external_titles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_ranking_entries" ADD CONSTRAINT "derived_ranking_entries_ranking_id_derived_ranking_definitions_id_fk" FOREIGN KEY ("ranking_id") REFERENCES "public"."derived_ranking_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_ranking_entries" ADD CONSTRAINT "derived_ranking_entries_title_id_external_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."external_titles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_title_genres_genre_id_idx" ON "external_title_genres" USING btree ("genre_id");--> statement-breakpoint
CREATE INDEX "external_title_images_title_id_idx" ON "external_title_images" USING btree ("title_id");--> statement-breakpoint
CREATE INDEX "external_availability_platform_country_idx" ON "external_availability" USING btree ("platform_id","country");--> statement-breakpoint
CREATE INDEX "external_availability_events_availability_bucket_idx" ON "external_availability_events" USING btree ("availability_id","dedupe_bucket_at");--> statement-breakpoint
CREATE INDEX "external_list_positions_title_id_idx" ON "external_list_positions" USING btree ("title_id");--> statement-breakpoint
CREATE INDEX "ops_sync_runs_pipeline_started_at_idx" ON "ops_sync_runs" USING btree ("pipeline","started_at");