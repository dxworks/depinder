-- fetch_log is read and pruned by time only: the retention sweep deletes rows older than
-- FETCH_LOG_RETENTION_DAYS, and the bench counts the rows in its run's window. Nothing looks rows
-- up by package.
create index if not exists fetch_log_started_at_idx on fetch_log (started_at);
drop index if exists fetch_log_package_idx;
