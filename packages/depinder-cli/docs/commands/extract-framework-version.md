# extractFrameworkVersion

```
depinder extractFrameworkVersion <projectPath> <outputPath>
```

Walks `<projectPath>` and writes one CSV with the framework version each manifest declares: the
`TargetFramework` of every `*proj`, the Java source/target of every `pom.xml`, `build.gradle`
and `build.gradle.kts`.

| Column | Meaning |
|---|---|
| `programmingLanguage` | `.NET` or `Java` |
| `projectFile` | Manifest path, relative to the root |
| `frameworkVersion` | As declared |
| `component`, `group` | The project's coordinates, where present |
| `notes` | Anything the parser had to guess |

No build tool runs; only the manifests are parsed.
