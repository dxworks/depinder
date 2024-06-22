# Depinder - Dependency analysis for software projects

The repository is found at: https://github.com/dxworks/depinder/tree/systems

Depinder offers comprehensive dependency analysis, identifying direct and transitive depen- dencies to provide a detailed understanding of the software’s dependency graph. It integrates security analysis by leveraging databases such as the GitHub Advisory Database and the Common Vulnerability Scoring System (CVSS) to detect and prioritize vulnerabilities. Additionally, the tool ensures license compliance by identifying and managing the licenses associated with each dependency, thus prevent- ing potential legal issues.


## Environment Variables

Depinder relies on GitHub and Libraries.io to get information about packages and known security vulnerabilities. In order to call these downstream services, you need to add two environment variables with the corresponding tokens:

- `GH_TOKEN` should contain a GitHub token with the read:packages scope.
- `LIBRARIES_IO_API_KEY` should contain the Libraries.io API Key.

## Run Locally

Clone the project

```bash
  git clone -b systems --single-branch https://github.com/dxworks/depinder
```

Go to the project directory

```bash
  cd depinder
```

Install dependencies

```bash
  npm install && cd depinder-fe && npm install && cd .. && cd server && npm install && tsc && cd .. && npm install
```

Start everything (Angular frontend, Express backend, Docker container):

```bash
  npm run start-all
```

If you would rather run each component separately:

```bash
  npm run start-fe
```
```bash
  npm run start-be
```

```bash
  npm run start-docker
```


## Analysing systems

For projects using Maven or Gradle, an additional command needs to be run to generate dependency tree files:

This should be run in the folder of a Maven project:
```bash
  mvn dependency:tree -DoutputFile=deptree.txt
```

This should be run in the folder of a Gradle project:
```bash
  gradle dependencies --configuration compileClasspath > deptree.txt
```
## Acknowledgements

Packagist api calls were inspired by [packagist-api-client](https://www.npmjs.com/package/packagist-api-client).
Depinder also uses some libraries from `Snyk.io` to parse dependency files.

## License

[Apache-2.0](https://choosealicense.com/licenses/apache)