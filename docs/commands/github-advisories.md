# github-advisories

```
depinder github-advisories download [options]
depinder github-advisories status   [options]
```

The local copy of GitHub's reviewed advisories, the `github` vulnerability source. Lives in
`cache/github-advisories/` under the working directory, one JSON file per ecosystem.

## download

| Option | Meaning | Default |
|---|---|---|
| `-e, --ecosystems <list>` | Ecosystems, GitHub or purl spelling (`npm,gem,maven,…`) | — |
| `-s, --sbom <folders...>` | Derive the ecosystems from these SBOMs | — |
| `--token-file <file>` | Dotenv-style file with `GH_TOKEN_1`, `GH_TOKEN_2`, … | `.github-tokens` |
| `--concurrency <n>` | Parallel ecosystem workers | token count, max 4 |
| `--max-age <hours>` | Skip ecosystems cached more recently | `24` |
| `--force` | Download even when fresh | off |

```bash
depinder github-advisories download --sbom ./sboms
```

## status

Prints the token pool and, per ecosystem, how many advisories are cached and how old they are.
Takes `--token-file` and `--max-age`.

## Tokens

`.github-tokens` in the working directory:

```
GH_TOKEN_1=ghp_...
GH_TOKEN_2=ghp_...
```

Contiguous from 1; the first gap ends the pool. A bare `GH_TOKEN` is a pool of one. The same
keys are read from the environment when the file is absent. Tokens rotate, one request each,
and are stood down before their rate limit is exhausted.
