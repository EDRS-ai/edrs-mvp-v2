CREATE TABLE `driver_job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`point_id` text NOT NULL,
	`driver_id` integer NOT NULL,
	`action` text NOT NULL,
	`reason_code` text,
	`notes` text,
	`evidence_json` text,
	`gps_lat` real,
	`gps_lng` real,
	`occurred_at` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`sync_source` text DEFAULT 'online' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`driver_id`) REFERENCES `drivers`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE INDEX `driver_job_events_point_idx` ON `driver_job_events` (`point_id`);
--> statement-breakpoint
CREATE INDEX `driver_job_events_driver_idx` ON `driver_job_events` (`driver_id`);
--> statement-breakpoint
CREATE INDEX `driver_job_events_occurred_idx` ON `driver_job_events` (`occurred_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `driver_job_events_idempotency_idx` ON `driver_job_events` (`idempotency_key`);
--> statement-breakpoint
CREATE TABLE `settlement_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`cycle_id` integer NOT NULL,
	`business_ref` text NOT NULL,
	`location_id` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`finalized_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`cycle_id`) REFERENCES `settlement_cycles`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE INDEX `settlement_groups_cycle_idx` ON `settlement_groups` (`cycle_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlement_groups_business_ref_idx` ON `settlement_groups` (`business_ref`);
--> statement-breakpoint
CREATE INDEX `settlement_groups_status_idx` ON `settlement_groups` (`status`);
--> statement-breakpoint
CREATE TABLE `settlement_legs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` text NOT NULL,
	`ledger_entry_id` integer NOT NULL,
	`party_org_id` integer,
	`leg_type` text NOT NULL,
	`direction` text NOT NULL,
	`amount_net` integer NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`idempotency_key` text NOT NULL,
	`effective_at` integer,
	`recorded_at` integer NOT NULL,
	`settled_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `settlement_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ledger_entry_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE INDEX `settlement_legs_group_idx` ON `settlement_legs` (`group_id`);
--> statement-breakpoint
CREATE INDEX `settlement_legs_party_idx` ON `settlement_legs` (`party_org_id`);
--> statement-breakpoint
CREATE INDEX `settlement_legs_status_idx` ON `settlement_legs` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlement_legs_ledger_entry_idx` ON `settlement_legs` (`ledger_entry_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlement_legs_idempotency_idx` ON `settlement_legs` (`idempotency_key`);
