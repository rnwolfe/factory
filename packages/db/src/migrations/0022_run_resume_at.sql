-- Auto-resume schedule for runs halted by a usage cap. When a run hits the
-- account usage limit it is marked status='usage_capped'; resume_at holds the
-- epoch-ms at which the daemon should auto-resume it (the parsed cap reset
-- time). Null when the run is not capped, or when the reset time was
-- unparseable / the cap recurred — those surface a blocked_run decision for
-- the operator instead.

ALTER TABLE `runs` ADD `resume_at` integer;
