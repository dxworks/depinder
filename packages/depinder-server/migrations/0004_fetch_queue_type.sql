-- The queue is drained per ecosystem as well as by priority: a pool slot stays taken while its
-- fetch waits in that ecosystem's limiter, so a front of the queue that is all cargo — one request
-- a second — would otherwise fill every slot and leave npm idle behind it. The type is derived
-- from the key (`pkg:<type>/...`), so nothing that inserts into the queue has to know about it.
alter table fetch_queue
    add column if not exists type text
        generated always as (split_part(split_part(package_key, ':', 2), '/', 1)) stored;

create index if not exists fetch_queue_type_idx on fetch_queue (type, priority, requested_at);
