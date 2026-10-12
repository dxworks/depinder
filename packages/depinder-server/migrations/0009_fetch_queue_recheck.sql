-- A fetch a feed event triggers often gets the registry's cached previous document (a CDN's
-- max-age, NuGet's registration lag), so every such fetch is followed by a second look once the
-- ecosystem's settle time has passed. These two columns carry that across the fetch in between.

-- Set by a feed event, cleared by the fetch that answers it, which schedules the second look.
alter table fetch_queue add column if not exists feed_event boolean not null default false;

-- When the scheduled second look is due. The row waits for it unless a request needs the package
-- fetched now; that fetch then hands the row back to this time.
alter table fetch_queue add column if not exists recheck_at timestamptz;

comment on column fetch_queue.feed_event is
    'A feed event named the package since its last fetch began: the fetch that answers it schedules a second look.';
comment on column fetch_queue.recheck_at is
    'When the second look after a feed-triggered fetch is due. A request that needs the package sooner pulls it forward.';
