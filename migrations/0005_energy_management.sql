CREATE TABLE `energy_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`location_id` text,
	`meter_id` text,
	`invoice_id` integer,
	`alert_type` text NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`detected_at` integer NOT NULL,
	`acknowledged_by` integer,
	`acknowledged_at` integer,
	`resolved_at` integer
);

--> statement-breakpoint
CREATE INDEX `energy_alerts_status_idx` ON `energy_alerts` (`status`);
--> statement-breakpoint
CREATE INDEX `energy_alerts_location_idx` ON `energy_alerts` (`location_id`);
--> statement-breakpoint
CREATE TABLE `energy_contracts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`supplier_id` integer NOT NULL,
	`location_id` text NOT NULL,
	`ppe` text NOT NULL,
	`tariff` text NOT NULL,
	`contracted_power_kw` real,
	`price_per_kwh` real NOT NULL,
	`fixed_monthly_grosze` integer DEFAULT 0 NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_to` integer,
	`payment_days` integer DEFAULT 14 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `energy_suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE INDEX `energy_contracts_supplier_idx` ON `energy_contracts` (`supplier_id`);
--> statement-breakpoint
CREATE INDEX `energy_contracts_location_idx` ON `energy_contracts` (`location_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `energy_contracts_ppe_idx` ON `energy_contracts` (`ppe`);
--> statement-breakpoint
CREATE TABLE `energy_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`supplier_id` integer NOT NULL,
	`contract_id` integer NOT NULL,
	`location_id` text NOT NULL,
	`invoice_number` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`consumption_kwh` real NOT NULL,
	`net_grosze` integer NOT NULL,
	`vat_grosze` integer NOT NULL,
	`gross_grosze` integer NOT NULL,
	`due_at` integer NOT NULL,
	`status` text DEFAULT 'RECEIVED' NOT NULL,
	`validation_status` text DEFAULT 'PENDING' NOT NULL,
	`expected_net_grosze` integer,
	`variance_pct` real,
	`document_id` integer,
	`bank_account` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `energy_suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contract_id`) REFERENCES `energy_contracts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE UNIQUE INDEX `energy_invoices_number_idx` ON `energy_invoices` (`supplier_id`,`invoice_number`);
--> statement-breakpoint
CREATE INDEX `energy_invoices_due_idx` ON `energy_invoices` (`due_at`);
--> statement-breakpoint
CREATE INDEX `energy_invoices_status_idx` ON `energy_invoices` (`status`);
--> statement-breakpoint
CREATE INDEX `energy_invoices_location_idx` ON `energy_invoices` (`location_id`);
--> statement-breakpoint
CREATE TABLE `energy_meters` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` integer NOT NULL,
	`location_id` text NOT NULL,
	`device_id` text,
	`serial` text NOT NULL,
	`model` text,
	`unit` text DEFAULT 'kWh' NOT NULL,
	`multiplier` real DEFAULT 1 NOT NULL,
	`source_type` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`installed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `energy_contracts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE UNIQUE INDEX `energy_meters_serial_idx` ON `energy_meters` (`serial`);
--> statement-breakpoint
CREATE INDEX `energy_meters_location_idx` ON `energy_meters` (`location_id`);
--> statement-breakpoint
CREATE INDEX `energy_meters_contract_idx` ON `energy_meters` (`contract_id`);
--> statement-breakpoint
CREATE TABLE `energy_payment_orders` (
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
	FOREIGN KEY (`invoice_id`) REFERENCES `energy_invoices`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE UNIQUE INDEX `energy_payment_orders_invoice_idx` ON `energy_payment_orders` (`invoice_id`);
--> statement-breakpoint
CREATE INDEX `energy_payment_orders_status_idx` ON `energy_payment_orders` (`status`);
--> statement-breakpoint
CREATE TABLE `energy_readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meter_id` text NOT NULL,
	`read_at` integer NOT NULL,
	`cumulative_kwh` real NOT NULL,
	`interval_kwh` real,
	`source` text DEFAULT 'manual' NOT NULL,
	`quality_status` text DEFAULT 'valid' NOT NULL,
	`note` text,
	`created_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`meter_id`) REFERENCES `energy_meters`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE UNIQUE INDEX `energy_readings_meter_time_idx` ON `energy_readings` (`meter_id`,`read_at`);
--> statement-breakpoint
CREATE INDEX `energy_readings_quality_idx` ON `energy_readings` (`quality_status`);
--> statement-breakpoint
CREATE TABLE `energy_suppliers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`nip` text,
	`contact_email` text,
	`bank_account` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX `energy_suppliers_nip_idx` ON `energy_suppliers` (`nip`);
