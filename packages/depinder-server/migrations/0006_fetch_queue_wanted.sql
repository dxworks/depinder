-- Until when someone is waiting for this package: a `/resolve` caller's deadline. While it is in
-- the future the row is urgent — dequeued before everything nobody waits for, and its requests
-- ahead of feed and sweep traffic in the registry limiters. Once it has passed, the row ranks by
-- its priority like any other. Several callers keep the latest of their deadlines.
alter table fetch_queue add column if not exists wanted_until timestamptz;

-- Urgency used to be priority 10. It is `wanted_until` now, and an ask whose caller has stopped
-- waiting is worth the same as news from a feed.
update fetch_queue set priority = 20 where priority = 10;
