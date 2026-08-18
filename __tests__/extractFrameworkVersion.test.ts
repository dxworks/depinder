import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { convertToCSV, extract, extractTargetFramework } from '../src/commands/extractFrameworkVersion';

describe('extractFrameworkVersion', () => {
    it('quotes framework versions containing commas', () => {
        const csv = convertToCSV([{
            programmingLanguage: '.NET',
            frameworkVersion: 'framework-one,framework-two',
            projectFile: 'src/example.csproj',
            component: 'src',
            group: 'src',
            notes: '',
        }]);

        expect(csv).toContain('.NET,"framework-one,framework-two",src/example.csproj,src,src,');
    });

    it('extracts repeated conditional TargetFrameworks values', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'depinder-framework-'));
        const projectFile = path.join(root, 'example.csproj');
        await fs.writeFile(projectFile, `<Project>
  <PropertyGroup>
    <TargetFrameworks>net8.0-android34.0</TargetFrameworks>
    <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net8.0</TargetFrameworks>
  </PropertyGroup>
</Project>`);

        await expect(extractTargetFramework(projectFile)).resolves.toBe('net8.0-android34.0 | $(TargetFrameworks);net8.0');
    });

    it('uses framework from nearest parent props file only when project has none', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'depinder-framework-'));
        const sourceDirectory = path.join(root, 'src', 'app');
        await fs.mkdir(sourceDirectory, { recursive: true });
        await fs.writeFile(path.join(root, 'src', 'framework.props'), '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
        await fs.writeFile(path.join(sourceDirectory, 'app.csproj'), '<Project />');

        await expect(extract(root)).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({
                projectFile: path.join('src', 'app', 'app.csproj'),
                frameworkVersion: 'net8.0',
                notes: path.join(root, 'src', 'framework.props'),
            }),
        ]));
    });

    it('keeps framework declared by project over parent props file', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'depinder-framework-'));
        const sourceDirectory = path.join(root, 'src');
        await fs.mkdir(sourceDirectory, { recursive: true });
        await fs.writeFile(path.join(sourceDirectory, 'framework.props'), '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
        await fs.writeFile(path.join(sourceDirectory, 'app.csproj'), '<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>');

        await expect(extract(root)).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ frameworkVersion: 'net9.0', notes: '' }),
        ]));
    });
});
