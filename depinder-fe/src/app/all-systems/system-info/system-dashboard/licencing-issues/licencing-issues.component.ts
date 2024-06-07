import {Component, Input, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {Dependency, Project} from "@core/project";
import {LibraryInfo} from "@core/library";
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {animate, state, style, transition, trigger} from "@angular/animations";
import {OldDepDetailsComponent} from "../old-dependencies-table/old-dep-details/old-dep-details.component";
import {MatListModule} from "@angular/material/list";
import {MatLineModule} from "@angular/material/core";

interface LicenceIssue {
  licenceID: string,
  projects?: string[],
  libraries: LibraryDisplay[],
  permissions?: string[],
  conditions?: string[],
  limitations?: string[],
  details?: string
}

interface LibraryDisplay {
  projectId: string;
  directLibraries?: LibraryInfo[];
  indirectLibraries: LibraryInfo[];
  seeAllDirectLibraries: boolean;
  seeAllIndirectLibraries: boolean;
}

@Component({
  selector: 'app-licencing-issues',
  standalone: true,
  imports: [CommonModule, MatTableModule, OldDepDetailsComponent, MatListModule, MatLineModule],
  templateUrl: './licencing-issues.component.html',
  styleUrl: './licencing-issues.component.css',
  animations: [
    trigger('detailExpand', [
      state('collapsed,void', style({height: '0px', minHeight: '0'})),
      state('expanded', style({height: '*'})),
      transition('expanded <=> collapsed', animate('225ms cubic-bezier(0.4, 0.0, 0.2, 1)')),
    ]),
  ],
})
export class LicencingIssuesComponent implements OnInit {
  @Input() projects: Project[] = [];
  @Input() libraries?: Map<string, LibraryInfo>;
  @Input() dependencies: Dependency[] = [];
  @Input() licences: any[] = [];

  constructor() { }

  columns = ['licenceID', 'projects', 'libraries', 'conditions', 'limitations', 'permissions', 'issues'];
  data: LicenceIssue[] = [];
  dataSource!: MatTableDataSource<LicenceIssue>;
  projectIDs: string[] = [];
  expandedElement?: LicenceIssue;

  ngOnInit() {
    this.projectIDs = this.projects.map(project => project._id);

    this.data = (this.licences ?? [])
      .filter(licence => this.hasDetailedInformation(licence))
      .map(licence => {
        let licenceLibraries: LibraryDisplay[] = [];  // Declare inside the map function

        this.projects.forEach(project => {
          for (let lib of licence.libraries) {
            if (project.dependencies.find(dep => dep.name === lib.name)) {
              let libraryDisplay = licenceLibraries.find(libraryDisplay => libraryDisplay.projectId === project._id);
              if (libraryDisplay) {
                lib.directDep ? libraryDisplay.directLibraries?.push(lib) : libraryDisplay.indirectLibraries.push(lib);
              } else {
                licenceLibraries.push({
                  projectId: project._id,
                  directLibraries: lib.directDep ? [lib] : [],
                  indirectLibraries: !lib.directDep ? [lib] : [],
                  seeAllDirectLibraries: false,
                  seeAllIndirectLibraries: false
                });
              }
            }
          }
        });

        return {
          licenceID: licence._id,
          permissions: licence.permissions,
          conditions: licence.conditions,
          limitations: licence.limitations,
          libraries: licenceLibraries,
          projects: licenceLibraries.map(libraryDisplay => libraryDisplay.projectId),
        }
      })

    this.data = Object.values(this.data.reduce((acc: any, cur) => {
      if (!acc[cur.licenceID]) {
        acc[cur.licenceID] = cur;
      } else {
        acc[cur.licenceID] = {
          ...acc[cur.licenceID],
          projects: [...(acc[cur.licenceID].projects || []), ...(cur.projects || [])].filter((project, index, self) =>
              index === self.findIndex((t) => (
                t.projectId === project.projectId
              ))
          ),
          libraries: [...(acc[cur.licenceID].libraries || []), ...(cur.libraries || [])].filter((library, index, self) =>
              index === self.findIndex((t) => (
                t.licenceID === library.licenceID
              ))
          ),
          permissions: cur.permissions,
          conditions: cur.conditions,
          limitations: cur.limitations,
        };
      }
      return acc;
    }, {}));

    this.data = this.data.filter((licence, index, self) =>
      this.isCopyleft(licence)
    );

    this.dataSource = new MatTableDataSource<LicenceIssue>(this.data);
  }

  isCopyleft(licence: LicenceIssue): boolean {
    return (licence.conditions?.includes('disclose-source') &&
      licence.conditions?.some(condition => condition.startsWith('same-license')) &&
      licence.conditions?.includes('document-changes')) ?? false;
  }

  hasDetailedInformation(licence: any) {
    return (licence?.permissions ?? []).length > 0 && (licence?.conditions ?? []).length > 0 && (licence?.limitations ?? []).length > 0;
  }
}
