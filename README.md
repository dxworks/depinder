# Dxworks depinder

This project was generated using the `dxworks-template-node-ts` repository template.

## Installation

Use `npm` to install

```shell
npm i -g @dxworks/depinder
```

or, to use it from `dxw cli`:

```shell
dxw plugin i @dxworks/depinder
```

To check if the installation was successful, run:

```shell
depinder --version
```

## Configuration
`Depinder` relies on `GitHub` and `Libraries.io` to get information about packages and known security vulnerabilities. In order to call these downstream services, you need to add two environment variables with the corresponding tokens:
- `GH_TOKEN` should contain a `GitHub` token with the `read:packages` scope.
- `LIBRARIES_IO_API_KEY` should contain the `Libraries.io` API Key.

## Preprocess data
If you want to run `Depinder` on a project that has not been processed by `Depminer` before, 
you need to run the following command to generate the folder structure:

```shell
dxw depminer construct <path-to-dx-dependencies-folder> <path-to-exported-folder>
```

After doing this, some package managers will require some more post-processing, in order to generate the `dependency tree` or the `lock file`.

### Maven
To generate the `dependency tree` for a maven project, run the following command in each project (or root project in case they contain modules):

```shell
mvn dependency:tree -DoutputFile=deptree.txt
```
This command should create a `deptree.txt` file next to each `pom.xml` file.
This file will be processed by MavenMiner to generate the a `pom.json` file, that corresponds to the expectations that the `Depinder` Java plugin has.


### Gradle
To generate the `dependency tree` for a gradle project, run the following command in each project (or root project in case they contain modules):

```shell
gradle dependencies --configuration compileClasspath > deptree.txt
```
This command should create a `deptree.txt` file next to each `build.gradle` file.
This file will be processed by GradleMiner to generate the a `gradle.json` file, that corresponds to the expectations that the `Depinder` Java plugin has.

## Usage
The following commands can be used either as standalone, or with the `dxw` prefix ahead.

### Cache command

To check if the MongoDB cache is running:
```shell
depinder cache
```

To initalise the Redis cache:
```shell
depinder cache init
```

To start the MongoDB cache:
```shell
depinder cache start
```

To stop the MongoDB cache:
```shell
depinder cache stop
```

To see what is available in the cache, please visit the [Mongo Express Dashboard](http://localhost:8002/).

### Analyse
To analyse a project, run the following command:

```shell
depinder analyse <paths-to-analysed-project-folders> ... -r <path-to-results-folder>
```
This command gets as an argument multiple fully qualified folder paths and will automatically run all plugins that are available for the project's used languages 
and export the results in the specified `results` folder.

### Start everything
```shell
npm run start-all
```

### Docker
```shell
npm run start-docker
```

### Backend
```shell
npm run start-be
```

### Frontend
```shell
npm run start-fe
```
Backend needs to be running for the frontend to work as expected.

## Acknowledgements

Packagist api calls were inspired by [packagist-api-client](https://www.npmjs.com/package/packagist-api-client).
Depinder also uses some libraries from `Snyk.io` to parse dependency files.

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

Please make sure to update tests as appropriate.

## License

[Apache-2.0](https://choosealicense.com/licenses/apache)
