import {ChangeDetectorRef, Component, Input, OnChanges, SimpleChanges} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as semver from 'semver';
import { SemVer, gt, parse, inc, rcompare } from 'semver';
import {Dependency, Project} from "@core/project";
import {LibrariesService} from "../../../../common/services/libraries.service";
import {forkJoin, map, Observable} from "rxjs";
import {LibraryInfo, LibraryVersion} from "@core/library";
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {Vulnerability} from "@core/vulnerability-checker";
import {MatButtonModule} from "@angular/material/button";
import {MatIconModule} from "@angular/material/icon";
import {animate, state, style, transition, trigger} from "@angular/animations";

interface VulnerableLibrary {
  name: string;
  version: string;
  vulnerabilities: Vulnerability[];
  suggestedVersion?: string;
  upgradeType?: string;
  introducedThrough?: string[][];
  seeAllIntroducedThrough: boolean;
  seeAllRequestedBy: boolean;
  requestedBy: string[];
}

@Component({
  selector: 'app-vulnerable-library-versions',
  standalone: true,
  imports: [CommonModule, MatTableModule, MatButtonModule, MatIconModule],
  templateUrl: './vulnerable-library-versions.component.html',
  styleUrl: './vulnerable-library-versions.component.css',
  animations: [
    trigger('detailExpand', [
      state('collapsed,void', style({height: '0px', minHeight: '0'})),
      state('expanded', style({height: '*'})),
      transition('expanded <=> collapsed', animate('225ms cubic-bezier(0.4, 0.0, 0.2, 1)')),
    ]),
  ],
})
export class VulnerableLibraryVersionsComponent implements OnChanges{
  @Input() projects: Project[] = [];
  dependencies: Dependency[] = [];
  libraries?: LibraryInfo[] = [];
  tableColumns: string[] = ['name', 'version', 'severity','suggestedVersion', 'upgradeType'];
  columnsToDisplayWithExpand: string[] = [...this.tableColumns, 'expand'];
  tableData: MatTableDataSource<VulnerableLibrary> = new MatTableDataSource<VulnerableLibrary>();
  expandedElement?: VulnerableLibrary;

  constructor(private libraryService: LibrariesService) { }

  ngOnChanges(change: SimpleChanges) {
    this.projects = change['projects'].currentValue;
    this.dependencies = [];
    this.libraries = [];

    if (this.projects.length > 0) {
      this.getDependencies().subscribe(libraries => {
        this.libraries = Array.from(libraries.values());
        this.updateData(libraries);
      });
    }
  }

  updateData(libraries: Map<string, LibraryInfo>) {
    const data: VulnerableLibrary[] = [];

    this.dependencies.map(dependency => {
      const library = libraries.get(dependency.name);
      const vulnerabilities = this.getVulnerabilities(dependency, library);

      if (vulnerabilities.length > 0) {
        const introducedThrough = this.getIntroducedThrough(dependency);
        this.updateExistingData(data, dependency, library, vulnerabilities, introducedThrough);
      }
    });

    this.sortAndSetData(data);
  }

  getVulnerabilities(dependency: Dependency, library: LibraryInfo | undefined): Vulnerability[] {
    return library?.vulnerabilities?.filter(vulnerability =>
      this.isVersionInRange(dependency.version, vulnerability.vulnerableRange!)) || [];
  }

  getIntroducedThrough(dependency: Dependency): string[][] {
    let introducedThrough = this.generateIntroducedThrough(dependency);
    introducedThrough = introducedThrough.map(path => path.reverse());
    return introducedThrough;
  }

  updateExistingData(data: VulnerableLibrary[], dependency: Dependency, library: LibraryInfo | undefined, vulnerabilities: Vulnerability[], introducedThrough: string[][]) {
    const existingData = data.find(d =>
      (d.name === dependency?.name) && (d.version === dependency.version) && (library?.name === d.name));

    if (existingData) {
      this.updateExistingDataVulnerabilities(existingData, vulnerabilities);
      this.updateExistingDataIntroducedThrough(existingData, introducedThrough);
      existingData.requestedBy = [...existingData.requestedBy ?? [], ...dependency.requestedBy];
    } else {
      this.createNewData(data, dependency, library, vulnerabilities, introducedThrough);
    }
  }

  updateExistingDataVulnerabilities(existingData: VulnerableLibrary, vulnerabilities: Vulnerability[]) {
    existingData.vulnerabilities = [...existingData.vulnerabilities, ...vulnerabilities];
    existingData.vulnerabilities = existingData.vulnerabilities.filter((vulnerability, index, self) =>
        index === self.findIndex((v) => (
          v.permalink === vulnerability.permalink && v.severity === vulnerability.severity
        ))
    );
  }

  updateExistingDataIntroducedThrough(existingData: VulnerableLibrary, introducedThrough: string[][]) {
    existingData.introducedThrough = [...existingData.introducedThrough ?? [], ...introducedThrough];

    function stringifyArray(arr: any[]): string {
      return arr.join(',');
    }

    existingData.introducedThrough = Array.from(
      new Set(existingData.introducedThrough.map(stringifyArray))
    ).map(item => item.split(','));
  }

  createNewData(data: VulnerableLibrary[], dependency: Dependency, library: LibraryInfo | undefined, vulnerabilities: Vulnerability[], introducedThrough: string[][]) {
    const suggestedVersion = this.determineUpgradeVersion(library?.vulnerabilities || [], dependency.version, library?.versions || []);
    data.push({
      name: library?.name || 'Unknown',
      version: dependency.version,
      vulnerabilities: vulnerabilities,
      suggestedVersion: suggestedVersion,
      introducedThrough: introducedThrough,
      seeAllIntroducedThrough: false,
      seeAllRequestedBy: false,
      requestedBy: dependency.requestedBy,
      upgradeType: this.determineUpgradeType(dependency.version, suggestedVersion)
    });
  }

  sortAndSetData(data: VulnerableLibrary[]) {
    data.sort((a, b) => {
      if (a.vulnerabilities.length === b.vulnerabilities.length) {
        return a.name.localeCompare(b.name);
      }
      return b.vulnerabilities.length - a.vulnerabilities.length;
    });
    this.tableData = new MatTableDataSource(data);
  }

  getDependencies(): Observable<Map<string, LibraryInfo>> {
    let libraries = new Map<string, LibraryInfo>();
    this.projects.forEach(project => {
      project.dependencies.forEach(dependency => {
        this.dependencies.push(dependency);
      });
    });

    //todo api call pentru toate librariile dintr-un proiect
    let observables = this.dependencies.filter(dep => dep.vulnerabilities).map(dependency => this.libraryService.find(dependency._id));
    return forkJoin(observables).pipe(
      map((librariesArray: LibraryInfo[]) => {
        librariesArray.forEach((lib, index) => {
          libraries.set(lib.name, lib);
        });
        return libraries;
      })
    );
  }

  parseVulnerableRange(rangeStr: string): Array<{ operator: string; version: string }> {
    return rangeStr.split(',').map(part => {
      const match = part.trim().match(/(>=|<=|>|<|=)\s*(\d+\.\d+\.\d+)/);
      if (!match) throw new Error(`Invalid version range part: ${part}`);
      return { operator: match[1], version: match[2] };
    });
  }

  determineUpgradeVersion(vulnerabilities: Vulnerability[], currentVersionStr: string, versions: LibraryVersion[]): string {
    let currentVersion = parse(currentVersionStr);
    if (!currentVersion) throw new Error(`Invalid current version: ${currentVersionStr}`);

    let upgradeVersion = currentVersion;
    vulnerabilities.forEach(vuln => {
      const constraints = this.parseVulnerableRange(vuln.vulnerableRange!);
      constraints.forEach(({ operator, version: versionStr }) => {
        let version = parse(versionStr);
        if (!version) {
          console.error(`Invalid vulnerable version: ${versionStr}`);
          return;
        }

        console.log('Vulnerable version:', versionStr,
          'Current version:', currentVersionStr,
          'Vulnerable range:', vuln.vulnerableRange,
          operator === '<' && rcompare(currentVersion!, version) >= 0,
          operator === '<=' && rcompare(currentVersion!, version) > 0
        );

        if ((operator === '<' && rcompare(currentVersion!, version) >= 0) ||
          (operator === '<=' && rcompare(currentVersion!, version) > 0)) {
          console.log('Vulnerable version:', versionStr, 'Current version:', currentVersionStr, 'Vulnerable range:', vuln.vulnerableRange);
          const nextVersion = inc(version, 'patch');
          if (nextVersion && gt(parse(nextVersion)!, upgradeVersion)) {
            upgradeVersion = parse(nextVersion) as SemVer;
          }
        }
      });
    });

    if (upgradeVersion === currentVersion || !gt(upgradeVersion, currentVersion)) {
      upgradeVersion = parse(inc(currentVersion, 'patch')) as SemVer;
    }

    for (let version of versions) {
      if (rcompare(upgradeVersion.version, version.version) >= 0) {
        upgradeVersion = parse(version.version)!;
        break;
      }
    }

    return upgradeVersion.version;
  }

  determineUpgradeType(currentVersionStr: string, newVersionStr: string): string {
    const currentVersion = parse(currentVersionStr);
    const newVersion = parse(newVersionStr);

    if (!currentVersion || !newVersion) {
      return 'invalid';
    }

    if (newVersion.major > currentVersion.major) {
      return 'major';
    } else if (newVersion.minor > currentVersion.minor) {
      return 'minor';
    } else if (newVersion.patch > currentVersion.patch) {
      return 'patch';
    } else {
      return 'none';
    }
  }

  generateIntroducedThrough(dependency: Dependency, path: string[] = []): string[][] {
    const currentPath = [...path, dependency.name + '@' + dependency.version];

    // Check for circular dependencies
    if (path.includes(dependency.name + '@' + dependency.version)) {
      return [currentPath];
    }

    let introducedThrough = [currentPath];

    if (!dependency.requestedBy) {
      return introducedThrough;
    }

    dependency.requestedBy.forEach(requester => {
      const requestedDependency = this.dependencies?.find(dep => dep.name + '@' + dep.version === requester);

      if (requestedDependency) {
        const newPaths = this.generateIntroducedThrough(requestedDependency, currentPath);
        introducedThrough = [...introducedThrough, ...newPaths];
      } else {
        introducedThrough.push([...currentPath, requester]);
      }
    });

    if (introducedThrough.length > 1) {
      introducedThrough = introducedThrough.slice(1);
    }

    return introducedThrough;
  }

  seeAllIntroducedThrough(element: VulnerableLibrary) {
    element.seeAllIntroducedThrough = !element.seeAllIntroducedThrough;
  }

  seeAllRequestedBy(element: VulnerableLibrary) {
    element.seeAllRequestedBy = !element.seeAllRequestedBy;
  }

  isVersionInRange(version: string, range: string): boolean {
    const conditions = range.split(',').map((part) => part.trim());

    return conditions.every((condition) => {
      const match = condition.match(/(<=|>=|<|>|=)?\s*(.*)/);
      if (!match) {
        console.error('Invalid version range condition:', condition);
        return false;
      }

      const [, operator, versionRange] = match;

      switch (operator) {
        case '<':
          return semver.lt(version, versionRange);
        case '<=':
          return semver.lte(version, versionRange);
        case '>':
          return semver.gt(version, versionRange);
        case '>=':
          return semver.gte(version, versionRange);
        case '=':
        case undefined: // Handle the case where no operator is specified, assuming equality
          return semver.eq(version, versionRange);
        default:
          console.error('Unsupported operator:', operator);
          return false;
      }
    });
  }

  getVulnerabilitySeverity(vulnerabilities: Vulnerability[]): string {
    return vulnerabilities.map(vulnerability => vulnerability.severity).join(', ');
  }

  getVulnerabilitiesPermalink(vulnerabilities: Vulnerability[]): string {
    return vulnerabilities.map(vulnerability => vulnerability.identifiers!.at(0)!.value).join(', ');
  }
}
