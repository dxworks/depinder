// The resolver is on by default at libs.dxworks.org: a developer's own token must never let a test
// reach it. Tests that need a resolver set these themselves.
delete process.env.DEPINDER_RESOLVER_URL
delete process.env.DEPINDER_RESOLVER_TOKEN
