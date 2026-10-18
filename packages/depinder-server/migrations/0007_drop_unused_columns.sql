-- Columns and indexes no query reads.

-- Every package row is tracked: nothing ever set the flag to false, so its filters and the partial
-- index on it selected everything. The poll loop still pages through one ecosystem by key.
create index if not exists package_type_key_idx on package (type, package_key);
drop index if exists package_type_tracked_idx;
alter table package drop column if exists tracked;

-- Written with every version, read by nothing: the package row holds the source and the fetch time.
alter table package_version drop column if exists source;
alter table package_version drop column if exists fetched_at;

-- Matched a dequeue ordered by next_attempt_at. The dequeue goes by type now (fetch_queue_type_idx).
drop index if exists fetch_queue_ready_idx;

comment on column package.fetched_at is
    'Last full fetch from the registry of record, stamped when the fetch started. Null for packages never fetched.';
