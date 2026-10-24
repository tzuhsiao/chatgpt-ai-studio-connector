CREATE TABLE `budget` (
	`owner` text NOT NULL,
	`window` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`owner`, `window`)
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`owner` text NOT NULL,
	`request_id` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`result` text,
	PRIMARY KEY(`owner`, `request_id`)
);
