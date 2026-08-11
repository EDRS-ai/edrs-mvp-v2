CREATE TABLE `doc_blobs` (
	`doc_id` integer NOT NULL,
	`idx` integer NOT NULL,
	`bytes` blob NOT NULL,
	PRIMARY KEY(`doc_id`, `idx`)
);

--> statement-breakpoint
CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer,
	`title` text NOT NULL,
	`category` text DEFAULT 'inne' NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`uploaded_by` integer,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE INDEX `documents_org_idx` ON `documents` (`org_id`);
--> statement-breakpoint
CREATE TABLE `statement_acceptances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`period` text NOT NULL,
	`accepted_by` integer NOT NULL,
	`accepted_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE UNIQUE INDEX `statement_acceptances_org_period_idx` ON `statement_acceptances` (`org_id`,`period`);
