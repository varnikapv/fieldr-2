CREATE TABLE `mutations` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`op_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`kind` text NOT NULL,
	`patch` text NOT NULL,
	`timestamp` integer NOT NULL,
	`synced` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mutations_op_id_unique` ON `mutations` (`op_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
