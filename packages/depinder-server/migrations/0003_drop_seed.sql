-- The database is no longer seeded from depinder's local sqlite cache: it fills itself on request,
-- from the registries of record. The importer is gone, and with it the flag that marked its rows.
-- Rows it wrote keep their null fetched_at and as_of (0002), so nothing vouches for them until
-- the worker fetches them again.
alter table package drop column if exists seed;
