-- Initial schema. Every timestamp is timestamptz: the service, the registries and Supabase are
-- in three different places and only absolute instants survive that.

create table if not exists package (
    package_key               text primary key,          -- pkg:<type>/<ns>/<name>, no version
    type                      text not null,
    namespace                 text,
    name                      text not null,
    description               text,
    homepage_url              text,
    repo_url                  text,
    licenses                  text[] not null default '{}',   -- library level
    latest_version            text,
    latest_prerelease_version text,
    status                    text not null default 'pending'
                                   check (status in ('pending', 'resolved', 'not_found', 'error')),
    error                     text,
    source                    text,                      -- hosts the facts came from
    fetched_at                timestamptz,               -- when we last talked to the registry
    as_of                     timestamptz,               -- freshness: feed cursor time, or fetched_at
    tracked                   boolean not null default true,
    seed                      boolean not null default false,
    -- Conditional-GET validators for poll-mode registries (maven, cargo).
    poll_etag                 text,
    poll_last_modified        text,
    -- Set for not_found (+24 h) and error (+1 h); the sweeper re-queues these when they come due.
    next_retry_at             timestamptz
);

-- The feed loops page through the tracked packages of one ecosystem.
create index if not exists package_type_tracked_idx on package (type, package_key) where tracked;
create index if not exists package_retry_idx on package (next_retry_at) where next_retry_at is not null;

create table if not exists package_version (
    purl        text primary key,                        -- package_key + '@' + version
    package_key text not null references package (package_key) on delete cascade,
    version     text not null,
    released_at timestamptz,
    licenses    text[] not null default '{}',
    prerelease  boolean not null default false,
    yanked      boolean not null default false,
    source      text,
    fetched_at  timestamptz
);

create index if not exists package_version_package_key_idx on package_version (package_key);

create table if not exists registry_feed (
    type               text primary key,
    mode               text not null check (mode in ('feed', 'poll')),
    cursor             text,                             -- opaque, per registry
    cursor_time        timestamptz,                      -- how far in time the cursor reaches
    last_run_at        timestamptz,
    last_ok_at         timestamptz,
    upstream_head_time timestamptz,
    last_error         text
);

create table if not exists fetch_queue (
    package_key     text primary key,
    priority        int not null default 50,             -- lower runs first
    requested_at    timestamptz not null default now(),
    attempts        int not null default 0,
    next_attempt_at timestamptz not null default now(),
    last_error      text
);

-- Matches the dequeue: ready rows first, then priority, then age.
create index if not exists fetch_queue_ready_idx on fetch_queue (next_attempt_at, priority, requested_at);

-- Provenance: one row per HTTP request the worker made on a package's behalf.
create table if not exists fetch_log (
    id          bigserial primary key,
    package_key text,
    source      text,
    url         text not null,
    http_status int,
    started_at  timestamptz not null,
    finished_at timestamptz not null,
    error       text
);

create index if not exists fetch_log_package_idx on fetch_log (package_key, started_at desc);
