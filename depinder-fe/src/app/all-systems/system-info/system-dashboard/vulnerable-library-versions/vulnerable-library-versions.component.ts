import {AfterViewInit, Component, Input, OnChanges, SimpleChanges, ViewChild} from '@angular/core';
import {CommonModule} from '@angular/common';
import * as semver from 'semver';
import {parse} from 'semver';
import {Dependency, Project} from "@core/project";
import {LibraryInfo, LibraryVersion} from "@core/library";
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {Vulnerability} from "@core/vulnerability-checker";
import {MatButtonModule} from "@angular/material/button";
import {MatIconModule} from "@angular/material/icon";
import {animate, state, style, transition, trigger} from "@angular/animations";
import {MatListModule} from "@angular/material/list";
import {MatPaginator, MatPaginatorModule} from "@angular/material/paginator";
import {MatTooltipModule} from "@angular/material/tooltip";
import {MatProgressSpinnerModule} from "@angular/material/progress-spinner";
import {MatGridListModule} from "@angular/material/grid-list";
import {MatCardModule} from "@angular/material/card";
import {VulnerableLibraryDetailsComponent} from "./vulnerable-library-details/vulnerable-library-details.component";
import {Severity} from "@core/constants";

export interface VulnerableLibrary {
  name: string;
  library: LibraryInfo;
  version: string;
  allVulnerabilities: Vulnerability[];
  vulnerabilities: Vulnerability[];
  upgradeType?: string;
  introducedThrough?: string[][];
  seeAllIntroducedThrough: boolean;
  seeAllRequestedBy: boolean;
  requestedBy: string[];
  requestedByProjects: string[];
  dependencyType: string;

  suggestedVersion?: string;
  patchVersion?: string;
  minorVersion?: string;
  majorVersion?: string;
}

@Component({
  selector: 'app-vulnerable-library-versions',
  standalone: true,
  imports: [CommonModule, MatTableModule, MatButtonModule, MatIconModule, MatListModule, MatPaginatorModule, MatTooltipModule, MatProgressSpinnerModule, MatGridListModule, MatCardModule, VulnerableLibraryDetailsComponent],
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
export class VulnerableLibraryVersionsComponent implements OnChanges, AfterViewInit {
  @Input() projects: Project[] = [];
  @Input() libraries?: Map<string, LibraryInfo>;
  @Input() dependencies: Dependency[] = [];

  tableColumns: string[] = ['name', 'dependency-type', 'version', 'severity','suggestedVersion', 'upgradeType'];
  tableData?: MatTableDataSource<VulnerableLibrary>;
  expandedElement?: VulnerableLibrary;

  @ViewChild(MatPaginator) paginator!: MatPaginator;

  constructor() { }

  ngOnChanges(change: SimpleChanges) {
    this.projects = change['projects'].currentValue;
    if (change['libraries'].currentValue !== undefined) {
      this.libraries = change['libraries'].currentValue;
    }
    if (change['dependencies'].currentValue !== undefined) {
      this.dependencies = change['dependencies'].currentValue;
    }

    if (this.projects.length > 0 && this.libraries !== undefined && this.libraries.size > 0) {
      this.updateData(this.libraries);
    }
  }

  ngAfterViewInit() {
    if (this.tableData) {
      this.tableData.paginator = this.paginator;
    }
  }

  updateData(libraries: Map<string, LibraryInfo>) {
    this.tableData = new MatTableDataSource<VulnerableLibrary>();
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
    this.tableData.paginator = this.paginator;
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
      try {
        this.createNewData(data, dependency, library, vulnerabilities, introducedThrough);
      }
      catch (e) {
        console.warn('Error creating new data:', e);
      }
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

    library!.versions = library?.versions.sort((a, b) => semver.compare(a.version, b.version)) ?? [];

    const patchVersion = this.determinePatchUpgradeVersion(library?.vulnerabilities ?? [], dependency.version, library?.versions || []);
    const minorVersion = this.determineMinorUpgradeVersion(library?.vulnerabilities ?? [], dependency.version, library?.versions || []);
    const requestedByProjects = Array.from(new Set<string>(introducedThrough.map(path => path[0])));

    const vulnerableLibrary: VulnerableLibrary = {
      name: library?.name || 'Unknown',
      library: library!,
      version: dependency.version,
      vulnerabilities: vulnerabilities,
      allVulnerabilities: library?.vulnerabilities || [],
      introducedThrough: introducedThrough,
      requestedByProjects: requestedByProjects,
      seeAllIntroducedThrough: false,
      seeAllRequestedBy: false,
      requestedBy: dependency.requestedBy,
      upgradeType: this.determineUpgradeType(dependency.version, suggestedVersion),
      dependencyType: dependency.directDep ? 'Direct' : 'Transitive',
      suggestedVersion: suggestedVersion,
      patchVersion: patchVersion ? (semver.gte(patchVersion, suggestedVersion) ? undefined : patchVersion) : undefined,
      minorVersion: minorVersion ? (semver.gte(minorVersion, suggestedVersion) ? undefined : minorVersion) : undefined
    };

    data.push(vulnerableLibrary);
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

  determineUpgradeVersion(vulnerabilities: Vulnerability[], currentVersionStr: string, versions: LibraryVersion[]): string {
    let currentVersion = parse(currentVersionStr);
    if (!currentVersion) throw new Error(`Invalid current version: ${currentVersionStr}`);

    let upgradeVersion = currentVersion;

    let checkedVersions=  versions.filter(libVer => {
      try {
        return semver.gt(libVer.version!, currentVersion!, false);
      }
      catch (e) {
        console.warn('Error comparing versions:', currentVersion, libVer.version, e);
        return false;
      }
    });

    for (let version of checkedVersions.sort((a, b) => semver.compare(a.version!, b.version))) {
      let vulnerabilities1 = vulnerabilities.filter(vulnerability =>
        semver.satisfies(version.version, vulnerability.vulnerableRange!));

      if (vulnerabilities1.length === 0) {
        upgradeVersion = parse(version.version)!;
        break;
      }
    }

    return upgradeVersion.version;
  }

  determinePatchUpgradeVersion(vulnerabilities: Vulnerability[], currentVersionStr: string, versions: LibraryVersion[]): string | undefined {
    let currentVersion = parse(currentVersionStr);
    if (!currentVersion) throw new Error(`Invalid current version: ${currentVersionStr}`);

    let currentVersionVulnerabilities = vulnerabilities.filter(vulnerability => this.isVersionInRange(currentVersionStr, vulnerability.vulnerableRange!));
    let upgradeVersion = currentVersion;

    let checkedVersions=  versions.filter(libVer => {
      return semver.gt(libVer.version!, currentVersion!) &&
        semver.patch(libVer.version!) > semver.patch(currentVersion!) &&
        semver.minor(libVer.version!) === semver.minor(currentVersion!) &&
        semver.major(libVer.version!) === semver.major(currentVersion!);
    }).sort((a, b) => semver.compare(a.version!, b.version));

    for (let version of checkedVersions.sort((a, b) => semver.compare(a.version!, b.version))) {
      let vulnerabilities1 = vulnerabilities.filter(vulnerability =>
        semver.satisfies(version.version, vulnerability.vulnerableRange!));

      if (this.compareVulnerabilities(currentVersionVulnerabilities, vulnerabilities1)) {
        upgradeVersion = parse(version.version)!;
        break;
      }
    }

    if (currentVersion === upgradeVersion) return undefined;
    return upgradeVersion.version;
  }

  determineMinorUpgradeVersion(vulnerabilities: Vulnerability[], currentVersionStr: string, versions: LibraryVersion[]): string | undefined {
    let currentVersion = parse(currentVersionStr);
    if (!currentVersion) throw new Error(`Invalid current version: ${currentVersionStr}`);

    let currentVersionVulnerabilities = vulnerabilities.filter(vulnerability => this.isVersionInRange(currentVersionStr, vulnerability.vulnerableRange!));
    let upgradeVersion = currentVersion;

    let checkedVersions=  versions.filter(libVer => {
      return semver.gt(libVer.version!, currentVersion!) &&
        semver.minor(libVer.version!) > semver.minor(currentVersion!) &&
        semver.major(libVer.version!) === semver.major(currentVersion!);
    }).sort((a, b) => semver.compare(a.version!, b.version));

    for (let version of checkedVersions.sort((a, b) => semver.compare(a.version!, b.version))) {
      let vulnerabilities1 = vulnerabilities.filter(vulnerability =>
        semver.satisfies(version.version, vulnerability.vulnerableRange!));

      if (this.compareVulnerabilities(currentVersionVulnerabilities, vulnerabilities1)) {
        upgradeVersion = parse(version.version)!;
        break;
      }
    }

    if (currentVersion === upgradeVersion) return undefined;
    return upgradeVersion.version;
  }

  compareVulnerabilities(a: Vulnerability[], b: Vulnerability[]): boolean {
    for (let severity of Object.values(Severity)) {
      const aCount = a.filter(v => v.severity === severity).length;
      const bCount = b.filter(v => v.severity === severity).length;
      if (aCount < bCount) {
        return false;
      }
      if (aCount > bCount) {
        return true;
      }
    }
    return false;
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

  isVersionInRange(version: string, range: string): boolean {
    return semver.satisfies(version, range);
    // const conditions = range.split(',').map((part) => part.trim());
    //
    // return conditions.every((condition) => {
    //   const match = condition.match(/(<=|>=|<|>|=)?\s*(.*)/);
    //   if (!match) {
    //     console.warn('Invalid version range condition:', condition);
    //     return false;
    //   }
    //
    //   const [, operator, versionRange] = match;
    //
    //   semver.outside(version, versionRange, '<');
    //
    //   try {
    //     switch (operator) {
    //       case '<':
    //         return semver.lt(version, versionRange);
    //       case '<=':
    //         return semver.lte(version, versionRange);
    //       case '>':
    //         return semver.gt(version, versionRange);
    //       case '>=':
    //         return semver.gte(version, versionRange);
    //       case '=':
    //       case undefined: // Handle the case where no operator is specified, assuming equality
    //         return semver.eq(version, versionRange);
    //       default:
    //         console.warn('Unsupported operator:', operator);
    //         return false;
    //     }
    //   }
    //   catch (e) {
    //     console.warn('Error comparing versions:', version, versionRange, e);
    //     return false;
    //   }
    // });
  }

  getVulnerabilitySeverity(vulnerabilities: Vulnerability[]): string {
    const severityValues: Map<String, number> = new Map([
      ['CRITICAL', 0],
      ['HIGH', 0],
      ['MEDIUM', 0],
      ['LOW', 0]
    ]);

    vulnerabilities.forEach(vulnerability => {
      if (severityValues.has(vulnerability.severity)) {
        severityValues.set(vulnerability.severity, severityValues.get(vulnerability.severity)! + 1);
      } else {
        severityValues.set(vulnerability.severity, 1);
      }
    });

    let severity = '';

    severityValues.forEach((value, key) => {
      if (value > 0) {
        severity += `${key} (${value}) `;
      }
    });

    return severity;
  }
}
