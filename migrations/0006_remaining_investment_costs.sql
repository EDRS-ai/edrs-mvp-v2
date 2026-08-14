CREATE TABLE `cost_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contract_id` integer,
	`invoice_id` integer,
	`category` text NOT NULL,
	`alert_type` text NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`detected_at` integer NOT NULL,
	`acknowledged_by` integer,
	`acknowledged_at` integer
);

--> statement-breakpoint
CREATE INDEX `cost_alerts_status_idx` ON `cost_alerts` (`status`);
--> statement-breakpoint
CREATE INDEX `cost_alerts_category_idx` ON `cost_alerts` (`category`);
--> statement-breakpoint
CREATE TABLE `cost_contracts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`vendor_name` text NOT NULL,
	`vendor_nip` text,
	`bank_account` text,
	`location_id` text,
	`device_id` text,
	`driver_id` integer,
	`contract_number` text NOT NULL,
	`title` text NOT NULL,
	`billing_model` text NOT NULL,
	`expected_monthly_net_grosze` integer DEFAULT 0 NOT NULL,
	`unit_rate` real,
	`unit_name` text,
	`budget_monthly_net_grosze` integer DEFAULT 0 NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_to` integer,
	`payment_days` integer DEFAULT 14 NOT NULL,
	`cost_center` text,
	`metadata_json` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX `cost_contracts_number_idx` ON `cost_contracts` (`contract_number`);
--> statement-breakpoint
CREATE INDEX `cost_contracts_category_idx` ON `cost_contracts` (`category`);
--> statement-breakpoint
CREATE INDEX `cost_contracts_location_idx` ON `cost_contracts` (`location_id`);
--> statement-breakpoint
CREATE TABLE `cost_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contract_id` integer NOT NULL,
	`category` text NOT NULL,
	`location_id` text,
	`invoice_number` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`quantity` real,
	`unit` text,
	`net_grosze` integer NOT NULL,
	`vat_grosze` integer NOT NULL,
	`gross_grosze` integer NOT NULL,
	`due_at` integer NOT NULL,
	`status` text DEFAULT 'RECEIVED' NOT NULL,
	`validation_status` text DEFAULT 'PENDING' NOT NULL,
	`expected_net_grosze` integer,
	`variance_pct` real,
	`document_id` integer,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `cost_contracts`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE UNIQUE INDEX `cost_invoices_number_idx` ON `cost_invoices` (`contract_id`,`invoice_number`);
--> statement-breakpoint
CREATE INDEX `cost_invoices_category_idx` ON `cost_invoices` (`category`);
--> statement-breakpoint
CREATE INDEX `cost_invoices_due_idx` ON `cost_invoices` (`due_at`);
--> statement-breakpoint
CREATE TABLE `cost_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contract_id` integer NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`metric_name` text NOT NULL,
	`value` real NOT NULL,
	`unit` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`quality_status` text DEFAULT 'valid' NOT NULL,
	`created_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `cost_contracts`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE INDEX `cost_metrics_contract_idx` ON `cost_metrics` (`contract_id`);
--> statement-breakpoint
CREATE INDEX `cost_metrics_period_idx` ON `cost_metrics` (`period_end`);
--> statement-breakpoint
CREATE TABLE `cost_payment_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`amount_grosze` integer NOT NULL,
	`status` text DEFAULT 'UNPLANNED' NOT NULL,
	`scheduled_at` integer,
	`approved_by` integer,
	`approved_at` integer,
	`export_reference` text,
	`paid_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `cost_invoices`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE UNIQUE INDEX `cost_payments_invoice_idx` ON `cost_payment_orders` (`invoice_id`);
--> statement-breakpoint
CREATE INDEX `cost_payments_status_idx` ON `cost_payment_orders` (`status`);
