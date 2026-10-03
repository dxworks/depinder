-- Whether a worker holds the row right now. The lease itself is still `next_attempt_at`; this only
-- tells the heartbeat which rows it may push out. A fetch that ended — kept due at once because it
-- was asked for again meanwhile, or put into backoff — clears it in the statement that settles the
-- row, so a heartbeat that lands after that statement leaves the new schedule alone.
alter table fetch_queue add column if not exists leased boolean not null default false;
