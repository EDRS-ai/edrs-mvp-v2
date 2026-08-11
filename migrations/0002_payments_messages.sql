CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`sender_user_id` integer NOT NULL,
	`sender_role` text NOT NULL,
	`body` text NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE INDEX `messages_org_idx` ON `messages` (`org_id`);
--> statement-breakpoint
CREATE INDEX `messages_created_idx` ON `messages` (`created_at`);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`amount_grosze` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider` text DEFAULT 'polcard_sandbox' NOT NULL,
	`reference` text NOT NULL,
	`ledger_entry_id` integer,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`paid_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE INDEX `payments_org_idx` ON `payments` (`org_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_reference_idx` ON `payments` (`reference`);
