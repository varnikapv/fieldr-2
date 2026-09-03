CREATE TABLE `visits` (
	`id` text PRIMARY KEY NOT NULL,
	`patient_name` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
