import {ChangeDetectorRef, Component, Input, OnChanges, SimpleChanges} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as semver from 'semver';
import {Dependency, Project} from "@core/project";
import {LibrariesService} from "../../../../common/services/libraries.service";
import {forkJoin, map, Observable} from "rxjs";
import {LibraryInfo} from "@core/library";
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
    if (this.projects.length > 0) {
      this.getDependencies().subscribe(libraries => {
        this.libraries = Array.from(libraries.values());

        let data: VulnerableLibrary[] = [];

        this.dependencies.map(dependency => {
          const library = libraries.get(dependency._id);
          const vulnerabilities = library?.vulnerabilities?.filter(vulnerability =>
            this.isVersionInRange(this.findDependencyVersion(library!), vulnerability.vulnerableRange!)) || [];
          if (vulnerabilities.length > 0) {
            let introducedThrough = this.generateIntroducedThrough(dependency);
            introducedThrough = introducedThrough.map(path => path.reverse());

            let existingData = data.find(d => (d.name === dependency?.name) && (d.version === dependency.version));

            if (existingData) {
              existingData.vulnerabilities = [...existingData.vulnerabilities, ...vulnerabilities];
              existingData.vulnerabilities = existingData.vulnerabilities.filter((vulnerability, index, self) =>
                  index === self.findIndex((v) => (
                    v.permalink === vulnerability.permalink && v.severity === vulnerability.severity
                  ))
              );
              existingData.introducedThrough = [...existingData.introducedThrough ?? [], ...introducedThrough];
            } else {
              data.push({
                name: dependency.name || library?.name || 'Unknown',
                version: dependency.version,
                vulnerabilities: library?.vulnerabilities?.filter(vulnerability =>
                  this.isVersionInRange(this.findDependencyVersion(library!), vulnerability.vulnerableRange!)) || [],
                suggestedVersion: this.getVersionWithoutVulnerabilities(library!)?.version ?? 'No suggestion',
                introducedThrough: introducedThrough,
              })
            }
          }
        });

        this.tableData = new MatTableDataSource(data);
      });
    }
  }

  getDependencies(): Observable<Map<string, LibraryInfo>> {
    let libraries = new Map<string, LibraryInfo>();
    this.projects.forEach(project => {
      project.dependencies.forEach(dependency => {
        this.dependencies.push(dependency);
      });
    });

    let observables = this.dependencies.filter(dep => dep.vulnerabilities).map(dependency => this.libraryService.find(dependency._id));
    return forkJoin(observables).pipe(
      map((librariesArray: LibraryInfo[]) => {
        librariesArray.forEach((lib, index) => {
          libraries.set(this.dependencies[index]._id, lib);
        });
        return libraries;
      })
    );
  }

  getVulnerabilitySeverity(vulnerabilities: Vulnerability[]): string {
    return vulnerabilities.map(vulnerability => vulnerability.severity).join(', ');
  }

  getVulnerabilitiesPermalink(vulnerabilities: Vulnerability[]): string {
    return vulnerabilities.map(vulnerability => vulnerability.identifiers!.at(0)!.value).join(', ');
  }

  findDependencyVersion(library: LibraryInfo): string {
    return this.dependencies.find(dependency => dependency.name === library.name)?.version || '';
  }

  isVersionInRange(version: string, range: string): boolean {
    // Split the condition string by commas to handle compound conditions
    const conditions = range.split(',').map((part) => part.trim());

    // Check each condition in the array
    return conditions.every((condition) => {
      // Extract the operator and the version from the condition
      const match = condition.match(/(<=|>=|<|>|=)?\s*(.*)/);
      if (!match) {
        console.error('Invalid version range condition:', condition);
        return false;
      }

      const [, operator, versionRange] = match;

      // Depending on the operator, use the appropriate semver function
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

  generateIntroducedThrough(dependency: Dependency, path: string[] = []): string[][] {
    const currentPath = [...path, dependency.name + '@' + dependency.version];
    let introducedThrough = [currentPath];

    dependency.requestedBy.forEach(requester => {
      const requestedDependency = this.dependencies?.find(dep => dep.name + '@' + dep.version === requester);

      if (requestedDependency) {
        // Instead of cloning, pass the current path to the recursive call
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

  getVersionWithoutVulnerabilities(library: LibraryInfo): { version: string } | null {
    // Get the library information for the given dependency
    // let library = this.libraries?.find(lib => lib.name === dependency.name);
    // if (!library) {
    //   this.libraryService.find(dependency._id).subscribe((lib) => {
    //     library = lib;
    //     if (!library) {
    //       console.error(`Library not found for dependency: ${dependency.name}`);
    //     }
    //   });
    //   return null;
    // }

    // Iterate over the versions of the library in descending order
    for (let i = library.versions.length - 1; i >= 0; i--) {
      const version = library.versions[i];

      // Check if the version has any vulnerabilities
      const hasVulnerabilities = library.vulnerabilities!.some(vulnerability =>
        this.isVersionInRange(version.version, vulnerability.vulnerableRange!));

      // If the version does not have any vulnerabilities, return it
      if (!hasVulnerabilities) {
        return version;
      }
    }

    // If no version is found without vulnerabilities, return null
    return null;
  }
}
