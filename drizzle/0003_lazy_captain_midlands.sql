CREATE TABLE `follow_ups` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `mutations` ADD `rejected` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mutations` ADD `rejection_reason` text;