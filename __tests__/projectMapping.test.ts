import { extractProjectInfo, verifyProjectPath, ProjectPathInfo } from '../src/utils/projectMapping';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs.existsSync
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn()
}));

describe('Project Mapping', () => {
    describe('extractProjectInfo', () => {
        it('should extract project path from npm paths with yarn delimiter', () => {
            const result = extractProjectInfo('module-transactionmanagement/owa/-yarn/babel-eslint/8.2.6/@babel/code-frame/7.0.0-beta.44', 'npmjs');
            expect(result.projectPath).toBe('module-transactionmanagement/owa');
        });

        it('should extract project path from npm paths with node_modules delimiter', () => {
            const result = extractProjectInfo('my-project/node_modules/lodash/4.17.21', 'npmjs');
            expect(result.projectPath).toBe('my-project');
        });

        it('should extract project path from npm paths with -npm delimiter', () => {
            const result = extractProjectInfo('my-project/-npm/react/17.0.2', 'npmjs');
            expect(result.projectPath).toBe('my-project');
        });

        it('should extract project path from complex monorepo npm paths', () => {
            const result = extractProjectInfo('packages\\package-client-registration-app/local/mycompany-package-client-management/-yarn/yup/0.29.3', 'npmjs');
            expect(result.projectPath).toBe('mycompany-package-client-management/packages/package-client-registration-app');
        });

        it('should extract project path from npm paths with version number segments', () => {
            const result = extractProjectInfo('@lib/my-client/1.2.3/my-client/test/-npm/@testing-library/jest-dom/5.17.0/@adobe/css-tools/4.4.0', 'npmjs');
            expect(result.projectPath).toBe('my-client/test');
        });

        it('should extract project path from npm paths with REPLACE_BY_CI segments', () => {
            const result = extractProjectInfo('@lib/my-client/REPLACE_BY_CI/my-client/test/-npm/@testing-library/jest-dom/5.17.0/@adobe/css-tools/4.4.0', 'npmjs');
            expect(result.projectPath).toBe('my-client/test');
        });

        it('should extract project path from npm paths with project name before version number', () => {
            const result = extractProjectInfo('some-api/0.1.0/-npm/serverless-python-requirements/5.0.1/child-process-ext/2.1.0', 'npmjs');
            expect(result.projectPath).toBe('some-api');
        });

        it('should extract project path from pip paths', () => {
            const result = extractProjectInfo('my-repo/load_data/-pip/aiosignal/1.3.2', 'pypi');
            expect(result.projectPath).toBe('my-repo/load_data');
        });

        it('should extract project path from Scala/sbt paths', () => {
            const result = extractProjectInfo('root:root_3.1:1.1.1-SNAPSHOT:myproject:-sbt/com.myproject:applogic_3.1:latest/com.typesafe.akka:akka-cluster-sharding-typed_3.1:3.1.19', 'maven');
            expect(result.projectPath).toBe('myproject');
        });

        it('should extract project path from Maven paths with :-maven delimiter', () => {
            const result = extractProjectInfo('org.mycompany.module:transactionmanagement-omod:6.2.0-SNAPSHOT:module-transactionmanagement/transactionmanagement-omod:-maven/org.mycompany.module:webservices.rest-omod:2.29.0', 'maven');
            expect(result.projectPath).toBe('module-transactionmanagement/transactionmanagement-omod');
        });

        it('should extract project path from Maven paths with org prefix', () => {
            const result = extractProjectInfo('com.company:some-app:1.0.0-SNAPSHOT:-maven/org.springframework.boot:spring-boot-starter-data-mongodb:3.4.0/org.mongodb:mongodb-driver-sync:5.2.1/org.mongodb:mongodb-driver-core:5.2.1/org.mongodb:bson-record-codec:5.2.1', 'maven');
            expect(result.projectPath).toBe('some-app');
        });

        it('should extract project path from Maven paths with pom.xml', () => {
            const result = extractProjectInfo('xlmapp/pom.xml/-maven/org.apache.logging.log4j:log4j-core:2.7', 'maven');
            expect(result.projectPath).toBe('xlmapp');
        });

        it('should extract project path from .NET paths', () => {
            const result = extractProjectInfo('Portal/1.0.0-/customer/Portal/Self/Self.csproj/-nuget/Chr.Avro/7.1.0', 'nuget');
            expect(result.projectPath).toBe('customer/Portal/Self');
        });

        it('should extract project path from .NET paths with relative paths', () => {
            const result = extractProjectInfo('DatabaseLibrary/1.0.0-/../../Downloads/voyager-target/database-library/DatabaseLibrary/DatabaseLibrary.csproj/-nuget/System.Text.Json/8.0.4', 'nuget');
            expect(result.projectPath).toBe('database-library/DatabaseLibrary');
        });

        it('should extract project path from .NET paths with longer relative paths', () => {
            const result = extractProjectInfo('DatabaseLibrary/1.0.0-/../../../user/Downloads/voyager-target/database-library/DatabaseLibrary/DatabaseLibrary.csproj/-nuget/System.Text.Json/8.0.4', 'nuget');
            expect(result.projectPath).toBe('database-library/DatabaseLibrary');
        });

        it('should extract project path from .NET paths with more segments', () => {
            const result = extractProjectInfo('DatabaseLibrary/1.0.0-/../../Downloads/voyager-target/data-library/DataLibrary/src/DataLibrary/DataLibrary.csproj/-nuget/Amazon.Lambda/2.7.1', 'nuget');
            expect(result.projectPath).toBe('data-library/DataLibrary/src/DataLibrary');
        });

        it('should extract project path with placeholder version suffix', () => {
            const result = extractProjectInfo('Service.Report/1.3.0.0-placeholder/../../Download/voyager-target/service-report/Service.Report.Test/Service.Report.Test.csproj/-nuget/Moq/4.15.0', 'nuget');
            expect(result.projectPath).toBe('service-report/Service.Report.Test');
        });

        it('should extract project path when version is upsecified for Gradle', () => {
            const result = extractProjectInfo('Deliver-Fast-2:idapi:unspecified:deliverfast/idapi:-gradle/androidx.fragment:fragment:1.5.4/androidx.activity:activity:1.7.0', 'maven');
            expect(result.projectPath).toBe('deliverfast/idapi');
        });

        it('should throw error when generic parser cannot determine project path', () => {
            // Path with no recognizable pattern and no version segments
            expect(() => {
                extractProjectInfo('path/without/any/recognizable/pattern/or/version', 'unknown');
            }).toThrow('No end delimiter found in path');
        });
    });

    describe('verifyProjectPath', () => {
        beforeEach(() => {
            // Reset mock before each test
            jest.clearAllMocks();
        });

        it('should return projectPathExists=true when path exists', () => {
            // Mock fs.existsSync to return true
            (fs.existsSync as jest.Mock).mockReturnValue(true);

            const result = verifyProjectPath('some/project/path', '/base/path');

            expect(result.projectPath).toBe('some/project/path');
            expect(result.verifiedPath).toBe('some/project/path');
            expect(result.projectPathExists).toBe(true);
            expect(fs.existsSync).toHaveBeenCalled();
        });

        it('should return projectPathExists=false when path does not exist', () => {
            // Mock fs.existsSync to return false
            (fs.existsSync as jest.Mock).mockReturnValue(false);

            const result = verifyProjectPath('some/project/path', '/base/path');

            expect(result.projectPath).toBe('some/project/path');
            expect(result.verifiedPath).toBe('');
            expect(result.projectPathExists).toBe(false);
            expect(fs.existsSync).toHaveBeenCalled();
        });

        it('should handle empty paths gracefully', () => {
            const result = verifyProjectPath('', '/base/path');

            expect(result.projectPath).toBe('');
            expect(result.verifiedPath).toBe('');
            expect(result.projectPathExists).toBe(false);
            expect(fs.existsSync).not.toHaveBeenCalled();
        });

        it('should handle empty base path gracefully', () => {
            const result = verifyProjectPath('some/project/path', '');

            expect(result.projectPath).toBe('some/project/path');
            expect(result.verifiedPath).toBe('');
            expect(result.projectPathExists).toBe(false);
            expect(fs.existsSync).not.toHaveBeenCalled();
        });
    });

    describe('extractProjectInfo with basePath', () => {
        beforeEach(() => {
            // Reset mock before each test
            jest.clearAllMocks();
        });

        it('should verify path when basePath is provided', () => {
            // Mock fs.existsSync to return true
            (fs.existsSync as jest.Mock).mockReturnValue(true);

            const result = extractProjectInfo('my-project/-npm/react/17.0.2', 'npmjs', '/base/path');

            expect(result.projectPath).toBe('my-project');
            expect(result.verifiedPath).toBe('my-project');
            expect(result.projectPathExists).toBe(true);
            expect(fs.existsSync).toHaveBeenCalled();
        });

        it('should set projectPathExists to undefined when basePath is not provided', () => {
            const result = extractProjectInfo('my-project/-npm/react/17.0.2', 'npmjs');

            expect(result.projectPath).toBe('my-project');
            expect(result.verifiedPath).toBe('');
            expect(result.projectPathExists).toBeUndefined();
            expect(fs.existsSync).not.toHaveBeenCalled();
        });
    });

});
