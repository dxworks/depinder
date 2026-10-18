-- Per-package freshness that can be trusted.
--
-- fetched_at is the last full fetch from the registry of record, stamped when that fetch started.
-- as_of is the latest instant the registry vouched for the facts: fetched_at after a full fetch,
-- moved forward when a maven/cargo conditional GET comes back 304. For a feed ecosystem the feed's
-- live cursor may vouch for more than as_of does; that is worked out at read time, not stored.
--
-- The backfill is conservative: where the old values cannot be shown to mean the above, they are
-- narrowed until they do.

-- When the feed started covering its ecosystem. A package fetched before this can have changed in
-- a stretch the feed never saw, so only packages fetched since count as covered by the cursor.
alter table registry_feed add column if not exists covered_since timestamptz;

-- The existing cursors' start is not on record, so coverage starts now: packages fetched before
-- this migration count only as fresh as their own fetch until they are fetched again.
update registry_feed set covered_since = now() where cursor is not null and covered_since is null;

-- How many times the package has been asked for while queued. A fetch deletes its queue row only
-- if the count is still the one it dequeued, so a feed event that lands mid-fetch is not
-- swallowed. A counter rather than a time, so no two clocks have to agree.
alter table fetch_queue add column if not exists requests int not null default 1;

-- Seeded rows carry depinder's cache time, which is not a fetch from the registry of record.
update package set fetched_at = null, as_of = null where seed;

-- Until now as_of was the feed cursor frozen at write time, which says less than fetched_at does.
-- The only confirmation any row has had so far is its fetch.
update package set as_of = fetched_at where fetched_at is not null and as_of is distinct from fetched_at;

-- Validators taken by the old first check may be newer than the data they stand for, and a 304
-- against them would vouch for facts the registry has since changed. The next sweep takes them
-- again, comparing Last-Modified with fetched_at.
update package
set poll_etag = null, poll_last_modified = null
where type in ('maven', 'cargo')
  and (poll_etag is not null or poll_last_modified is not null);

comment on column package.fetched_at is
    'Last full fetch from the registry of record, stamped when the fetch started. Null for seeded rows and for packages never fetched.';
comment on column package.as_of is
    'Latest instant the registry vouched for these facts: fetched_at, or later after a 304 on a maven/cargo poll.';
comment on column registry_feed.covered_since is
    'When this feed began covering its ecosystem. Packages fetched since count as fresh up to cursor_time.';
comment on column fetch_queue.requests is
    'Times the package was asked for while queued. A fetch that dequeued a lower count leaves the row to run again.';
